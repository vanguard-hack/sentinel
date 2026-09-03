// Crime-link / criminal-network analysis.
//
// Builds a CO-OFFENDING network from the Data Store: two people are linked when
// they appear as accused in the SAME FIR, and the same person is tracked across
// FIRs by their global PersonID. From that graph we derive the structures the
// literature on criminal-network analysis relies on:
//   • connected components  → distinct networks / rings (gangs);
//   • degree centrality      → the most-connected offenders (likely leaders);
//   • local clustering       → tight lieutenants (high) vs brokers/bridges (low);
//   • repeat offenders       → persons appearing in ≥2 cases;
//   • crime-to-crime links   → cases connected through shared offenders.
//
// ZCQL has no joins and caps a query at ~300 rows, so everything is paged and
// stitched client-side (see also utils/incidents.js).
import { pageQuery, fetchSharedCases, fetchSharedAccused } from './datastore';

const GENDER = { 1: 'M', 2: 'F', 3: 'T' };

// Paging lives in datastore.pageQuery, which reports when it stopped short.
// Three modules each had their own copy of this loop with a different
// ceiling, and at 30,000 cases all three silently truncated.
const fetchAll = (baseSql, table) => pageQuery(baseSql, table, { cap: 60000 });

async function mapOf(table, idCol, cols) {
  const rows = await fetchAll(`SELECT ${[idCol, ...cols].join(', ')} FROM ${table}`, table);
  const m = new Map();
  rows.forEach((r) => m.set(String(r[idCol]), r));
  return m;
}

// Union–Find for connected components.
class DSU {
  constructor() { this.p = new Map(); }
  find(x) {
    if (!this.p.has(x)) this.p.set(x, x);
    while (this.p.get(x) !== x) { this.p.set(x, this.p.get(this.p.get(x))); x = this.p.get(x); }
    return x;
  }
  union(a, b) { this.p.set(this.find(a), this.find(b)); }
}

const mode = (arr) => {
  const c = new Map();
  let best = null; let bn = 0;
  arr.forEach((v) => { const n = (c.get(v) || 0) + 1; c.set(v, n); if (n > bn) { bn = n; best = v; } });
  return best;
};

export async function fetchCrimeNetwork() {
  const [accused, cases, units, districts, heads, subheads, statuses] = await Promise.all([
    fetchSharedAccused(),
    fetchSharedCases(),
    mapOf('Unit', 'UnitID', ['UnitName', 'DistrictID']),
    mapOf('District', 'DistrictID', ['DistrictName']),
    mapOf('CrimeHead', 'CrimeHeadID', ['CrimeGroupName']),
    mapOf('CrimeSubHead', 'CrimeSubHeadID', ['CrimeHeadName']),
    mapOf('CaseStatusMaster', 'CaseStatusID', ['CaseStatusName']),
  ]);

  // Case lookup with resolved names.
  const caseById = new Map();
  cases.forEach((c) => {
    const unit = units.get(String(c.PoliceStationID));
    const district = unit ? districts.get(String(unit.DistrictID))?.DistrictName : '';
    caseById.set(String(c.CaseMasterID), {
      id: String(c.CaseMasterID),
      crimeNo: c.CrimeNo,
      date: String(c.CrimeRegisteredDate || '').slice(0, 10),
      station: unit?.UnitName || '—',
      district: district || '—',
      type: subheads.get(String(c.CrimeMinorHeadID))?.CrimeHeadName
        || heads.get(String(c.CrimeMajorHeadID))?.CrimeGroupName || '—',
      status: statuses.get(String(c.CaseStatusID))?.CaseStatusName || '—',
      heinous: String(c.GravityOffenceID) === '1',
    });
  });

  // People and case membership, keyed by global PersonID.
  const persons = new Map();  // pid -> person
  const caseMembers = new Map(); // caseId -> [pid]
  accused.forEach((r) => {
    const pid = String(r.PersonID || '').trim();
    const cid = String(r.CaseMasterID);
    if (!pid || !caseById.has(cid)) return;
    let p = persons.get(pid);
    if (!p) {
      p = { pid, names: [], gender: GENDER[String(r.GenderID)] || '?', age: 0, cases: new Set(), districts: [], types: [], co: new Set() };
      persons.set(pid, p);
    }
    if (r.AccusedName) p.names.push(r.AccusedName);
    p.age = Math.max(p.age, Number(r.AgeYear) || 0);
    p.cases.add(cid);
    const c = caseById.get(cid);
    p.districts.push(c.district);
    p.types.push(c.type);
    (caseMembers.get(cid) || caseMembers.set(cid, []).get(cid)).push(pid);
  });

  // Co-offending edges (weight = shared cases) + degree.
  const edgeW = new Map(); // "a|b" -> weight
  const dsu = new DSU();
  persons.forEach((p) => dsu.find(p.pid));
  caseMembers.forEach((pids) => {
    const uniq = [...new Set(pids)];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const a = uniq[i]; const b = uniq[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        edgeW.set(key, (edgeW.get(key) || 0) + 1);
        persons.get(a).co.add(b);
        persons.get(b).co.add(a);
        dsu.union(a, b);
      }
    }
  });

  // Finalise per-person fields.
  persons.forEach((p) => {
    p.name = mode(p.names) || p.pid;
    p.district = mode(p.districts) || '—';
    p.topType = mode(p.types) || '—';
    p.caseCount = p.cases.size;
    p.degree = p.co.size;
  });

  // Local clustering coefficient → distinguishes tight members from brokers.
  const adj = persons;
  persons.forEach((p) => {
    const nb = [...p.co];
    if (nb.length < 2) { p.clustering = 0; return; }
    let links = 0;
    for (let i = 0; i < nb.length; i++) {
      for (let j = i + 1; j < nb.length; j++) {
        if (adj.get(nb[i]).co.has(nb[j])) links++;
      }
    }
    p.clustering = (2 * links) / (nb.length * (nb.length - 1));
  });

  // Group persons into components.
  const comps = new Map(); // root -> [pid]
  persons.forEach((p) => {
    const r = dsu.find(p.pid);
    (comps.get(r) || comps.set(r, []).get(r)).push(p.pid);
  });

  // Build network objects for components with ≥3 members (a "ring").
  const networks = [];
  comps.forEach((members) => {
    if (members.length < 3) return;
    const memberSet = new Set(members);
    const edges = [];
    edgeW.forEach((w, key) => {
      const [a, b] = key.split('|');
      if (memberSet.has(a) && memberSet.has(b)) edges.push({ source: a, target: b, weight: w });
    });
    const caseIds = new Set();
    const districtsArr = [];
    const typesArr = [];
    members.forEach((pid) => {
      const p = persons.get(pid);
      p.cases.forEach((c) => caseIds.add(c));
      districtsArr.push(p.district);
      typesArr.push(p.topType);
    });
    const memberObjs = members
      .map((pid) => persons.get(pid))
      .sort((a, b) => b.degree - a.degree || b.caseCount - a.caseCount);
    const dates = [...caseIds].map((c) => caseById.get(c)?.date).filter(Boolean).sort();
    networks.push({
      id: dsu.find(members[0]),
      size: members.length,
      members: memberObjs,
      edges,
      caseIds: [...caseIds],
      district: mode(districtsArr) || '—',
      topType: mode(typesArr) || '—',
      leader: memberObjs[0],
      dateFrom: dates[0] || '',
      dateTo: dates[dates.length - 1] || '',
    });
  });
  networks.sort((a, b) => b.size - a.size || b.edges.length - a.edges.length);
  networks.forEach((n, i) => { n.rank = i + 1; });

  // Key players across the whole graph (by connections, then activity).
  const linked = [...persons.values()].filter((p) => p.degree > 0);
  // Kept deep rather than trimmed to a dozen — the panels paginate, so an
  // analyst can work down the ranking instead of only seeing the head of it.
  const keyPlayers = [...linked]
    .sort((a, b) => b.degree - a.degree || b.caseCount - a.caseCount)
    .slice(0, 300);

  // Repeat offenders (≥2 cases), most active first.
  const repeatOffenders = [...persons.values()]
    .filter((p) => p.caseCount >= 2)
    .sort((a, b) => b.caseCount - a.caseCount || b.degree - a.degree)
    .slice(0, 300);

  return {
    caseById,
    persons,
    networks,
    keyPlayers,
    repeatOffenders,
    summary: {
      offenders: persons.size,
      linked: linked.length,
      pairs: edgeW.size,
      rings: networks.length,
      largest: networks[0]?.size || 0,
      repeat: [...persons.values()].filter((p) => p.caseCount >= 2).length,
    },
  };
}

// Turn a network into a spec for <NetworkGraph>. Oversized rings are trimmed to
// their highest-degree core so the force layout stays readable.
// The whole ring, always. This used to keep only the 60 best-connected members
// and silently drop every edge touching the rest, so the graph disagreed with
// the "N members · M links" header above it. An investigator comparing the two
// has no way to tell which is right, so the graph now renders the ring in full.
// ── Person naming ───────────────────────────────────────────────────────────
// Accused names in the FIR schema carry a leading initial and sometimes a
// quoted alias: `D. Puneeth Naik`, `B. Basavaraj Pai "Chief"`. Splitting on the
// first space therefore yields "D." — which is how every ring in the UI came to
// be called "D.'s ring", three of them at once, with the actual person hidden
// behind an initial that identifies nobody.
//
// So the initial is skipped rather than treated as a name. A quoted alias is
// dropped from the formal name but preferred for a RING label, because a ring
// is known by what its leader is called, not by their record name.
const ALIAS = /["“]([^"”]+)["”]/;
const INITIAL = /^[A-Za-z]\.?$/;

function nameParts(full) {
  const raw = String(full || '').trim();
  const alias = (ALIAS.exec(raw) || [])[1] || '';
  const words = raw.replace(ALIAS, ' ').trim().split(/\s+/).filter(Boolean);
  const named = words.filter((w) => !INITIAL.test(w));
  return { alias, words: named.length ? named : words };
}

// "D. Puneeth Naik" -> "Puneeth Naik". The name an officer would read out.
export function personName(full) {
  const { words } = nameParts(full);
  return words.join(' ') || '—';
}

// "D. Puneeth Naik" -> "Puneeth". For graph nodes, where space is scarce.
export function personShortName(full) {
  const { words } = nameParts(full);
  return words[0] || '—';
}

// What the ring is called. Prefers the leader's alias when the record carries
// one, since that is how a network is actually known.
export function ringName(leader) {
  const raw = leader && leader.name;
  if (!raw) return 'Unnamed ring';
  const { alias } = nameParts(raw);
  return `${alias || personName(raw)}\u2019s ring`;
}

export function networkToSpec(net) {
  const nodes = net.members.map((p) => ({ id: p.pid, label: personShortName(p.name), group: p.district }));
  return { nodes, links: net.edges, trimmed: 0 };
}

// ── Full-network overview ───────────────────────────────────────────────────
// One node per RING, not per person.
//
// Drawing every member of every ring put ~1,000 unlabelled dots on screen: the
// structure was there but nothing was legible, and no officer could tell one
// cluster from another. Graph explorers that work at this scale (Connected
// Papers, Obsidian's graph view) draw one labelled node per entity and let you
// open it for detail — so a node here is a ring, sized by membership, coloured
// by district, labelled by its leader. The members live one click away in the
// ring view, which already draws them in full.
//
// EDGES between rings are attribute links, not co-offending. A ring is a
// connected component of the co-offending graph, so two rings can never share
// a member — if they did they would be one ring. These edges say "these groups
// work the same district, or the same racket", which is a real lead derived
// from the case records. Inventing person-to-person links across rings would
// have made the picture connected by asserting relationships the records do
// not support.

function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rings sharing operating ground or crime type. Within a district rings hang
// off the district's largest; district hubs are then bridged where they share
// a primary crime type, which pulls most rings into a few components while
// leaving genuinely unique ones standalone.
function buildRingLinks(nets) {
  const links = [];
  const byDistrict = new Map();
  const byType = new Map();
  nets.forEach((net, i) => {
    const d = net.district || '—';
    const t = net.topType || '—';
    if (d !== '—') (byDistrict.get(d) || byDistrict.set(d, []).get(d)).push(i);
    if (t !== '—') (byType.get(t) || byType.set(t, []).get(t)).push(i);
  });

  const districtHub = new Map();
  byDistrict.forEach((idxs, district) => {
    const sorted = [...idxs].sort((a, b) => nets[b].size - nets[a].size);
    districtHub.set(district, sorted[0]);
    sorted.slice(1).forEach((i) => links.push({ a: sorted[0], b: i, kind: 'district', label: district }));
  });
  byType.forEach((idxs, type) => {
    const hubs = [...new Set(idxs.map((i) => districtHub.get(nets[i].district || '—')).filter((h) => h != null))];
    for (let i = 1; i < hubs.length; i++) links.push({ a: hubs[i - 1], b: hubs[i], kind: 'type', label: type });
  });
  return links;
}

// Force-directed layout, run once here rather than in the browser on every
// load. Repulsion is O(n²), which is fine for a few hundred rings and keeps
// the code readable; springs pull linked rings together and a weak pull to the
// centre stops disconnected rings drifting away.
function layoutForce(nodes, links, rnd, iterations = 420) {
  const n = nodes.length;
  if (!n) return;
  nodes.forEach((nd, i) => {
    const a = (i / n) * Math.PI * 2 + rnd() * 0.6;
    const r = 120 + rnd() * 260;
    nd.x = Math.cos(a) * r;
    nd.y = Math.sin(a) * r;
    nd.vx = 0;
    nd.vy = 0;
  });

  const deg = nodes.map(() => 0);
  links.forEach((l) => { deg[l.s] += 1; deg[l.t] += 1; });

  for (let it = 0; it < iterations; it++) {
    const cool = 1 - it / iterations;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (rnd() - 0.5) * 0.5; dy = (rnd() - 0.5) * 0.5; d2 = 0.25; }
        // Bigger rings push harder, so they claim the space their label needs.
        const push = (3200 + (nodes[i].r + nodes[j].r) * 210) / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * push;
        const fy = (dy / d) * push;
        nodes[i].vx -= fx; nodes[i].vy -= fy;
        nodes[j].vx += fx; nodes[j].vy += fy;
      }
    }
    links.forEach((l) => {
      const a = nodes[l.s];
      const b = nodes[l.t];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const rest = 110 + a.r + b.r;
      const f = (d - rest) * 0.012;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    });
    nodes.forEach((nd) => {
      // Weak centring, weaker for well-connected rings so hubs stay central.
      nd.vx += -nd.x * 0.0016 * (1 + 1 / (1 + deg[nodes.indexOf(nd)] || 1)) * 0;
      nd.vx += -nd.x * 0.0018;
      nd.vy += -nd.y * 0.0018;
      nd.vx *= 0.86; nd.vy *= 0.86;
      nd.x += nd.vx * cool;
      nd.y += nd.vy * cool;
    });
  }
}

export function buildOverview(networks, { topN = 70 } = {}) {
  const rnd = seededRandom(0x5E27);
  // networks arrive sorted largest-first, so the top slice is the most
  // significant rings — the rest stay reachable from the sidebar.
  const shown = networks.slice(0, Math.max(1, topN));

  const nodes = shown.map((net, i) => ({
    ring: i,
    id: net.id,
    label: ringName(net.leader),
    group: net.district || '—',
    size: net.size,
    crimes: net.caseIds.length,
    type: net.topType || '—',
    r: 10 + Math.sqrt(net.size) * 6.2,
    x: 0,
    y: 0,
  }));

  const ringLinks = buildRingLinks(shown)
    .filter((l) => l.a < nodes.length && l.b < nodes.length)
    .map((l) => ({ s: l.a, t: l.b, kind: l.kind, label: l.label }));

  layoutForce(nodes, ringLinks, rnd);

  // Connected groups, for the header.
  const parent = nodes.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  ringLinks.forEach((l) => { const a = find(l.s); const b = find(l.t); if (a !== b) parent[a] = b; });
  const groups = new Set(nodes.map((_, i) => find(i)));
  const linked = new Set();
  ringLinks.forEach((l) => { linked.add(l.s); linked.add(l.t); });

  // Normalise into a 0..1000 box so the renderer can fit any dataset.
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = 900 / span;
  nodes.forEach((n) => {
    n.x = (n.x - minX) * scale + 50;
    n.y = (n.y - minY) * scale + 50;
    n.r *= Math.max(0.6, Math.min(1.6, scale));
  });

  return {
    nodes,
    links: ringLinks,
    shown: nodes.length,
    total: networks.length,
    clusters: groups.size,
    isolated: nodes.length - linked.size,
  };
}
