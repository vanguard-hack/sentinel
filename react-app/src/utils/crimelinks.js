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
import { runQuery } from './datastore';

const GENDER = { 1: 'M', 2: 'F', 3: 'T' };
const CAP = 300;

async function fetchAll(baseSql, table) {
  const out = [];
  for (let off = 0; off < 30000; off += CAP) {
    const rows = await runQuery(`${baseSql} LIMIT ${off}, ${CAP}`, table);
    out.push(...rows);
    if (rows.length < CAP) break;
  }
  return out;
}

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
    fetchAll('SELECT CaseMasterID, AccusedName, GenderID, AgeYear, PersonID FROM Accused', 'Accused'),
    fetchAll('SELECT CaseMasterID, CrimeNo, CrimeRegisteredDate, PoliceStationID, CrimeMajorHeadID, CrimeMinorHeadID, CaseStatusID, GravityOffenceID FROM CaseMaster', 'CaseMaster'),
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
  const keyPlayers = [...linked]
    .sort((a, b) => b.degree - a.degree || b.caseCount - a.caseCount)
    .slice(0, 12);

  // Repeat offenders (≥2 cases), most active first.
  const repeatOffenders = [...persons.values()]
    .filter((p) => p.caseCount >= 2)
    .sort((a, b) => b.caseCount - a.caseCount || b.degree - a.degree)
    .slice(0, 12);

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
export function networkToSpec(net) {
  const nodes = net.members.map((p) => ({ id: p.pid, label: p.name.split(' ')[0], group: p.district }));
  return { nodes, links: net.edges, trimmed: 0 };
}

// ── Full-network overview ───────────────────────────────────────────────────
// Every ring laid out at once, so an officer sees the whole linkage landscape
// before drilling into one.
//
// Layout is computed here rather than simulated in the browser on each load: a
// force pass over every node at once would be slow and would tangle unrelated
// rings together.
//
// TWO KINDS OF EDGE, and the distinction matters:
//
//   • Co-offending links (thin, inside a ring) — two people named as accused
//     in the same FIR. This is the hard evidence the ring is built from. A
//     "ring" is a connected component of these links, which is exactly why two
//     rings can never share a member: if they did, they would be one ring.
//
//   • Ring links (thick, between rings) — two rings that operate in the same
//     district or around the same primary crime type. These are NOT claims
//     that anyone co-offended across rings; they say "these groups work the
//     same ground or the same racket", which is a real, derivable lead and is
//     labelled as such in the UI.
//
// Inventing person-to-person links across rings would have been the easy way
// to make the picture connected, but it would put relationships on screen that
// the case records do not support — not acceptable in an investigative tool.
// Attribute links give the connected structure honestly.
//
// Placement is deliberately irregular: rings are scattered by dart-throwing
// with rejection rather than packed on a spiral, which read as generated. The
// PRNG is seeded, so the scatter is irregular but identical on every load.

function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Connect rings that share operating ground or crime type. Within a district
// the rings hang off the district's biggest ring, and district hubs are then
// joined where they share a primary crime type — which pulls most rings into a
// few large super-clusters while leaving genuinely unique rings isolated.
function buildRingLinks(networks) {
  const links = [];
  const byDistrict = new Map();
  const byType = new Map();

  networks.forEach((net, i) => {
    const d = net.district || '—';
    const t = net.topType || '—';
    if (d !== '—') (byDistrict.get(d) || byDistrict.set(d, []).get(d)).push(i);
    if (t !== '—') (byType.get(t) || byType.set(t, []).get(t)).push(i);
  });

  // District hub-and-spoke: rings sorted by size, everything hangs off the
  // largest, so each district becomes one cluster.
  const districtHub = new Map();
  byDistrict.forEach((idxs, district) => {
    const sorted = [...idxs].sort((a, b) => networks[b].size - networks[a].size);
    const hub = sorted[0];
    districtHub.set(district, hub);
    sorted.slice(1).forEach((i) => links.push({ a: hub, b: i, kind: 'district', label: district }));
  });

  // Bridge districts that work the same racket, chaining the district hubs of
  // each crime type. This is what joins the district clusters into a handful
  // of large components rather than dozens of islands.
  byType.forEach((idxs, type) => {
    const hubs = [...new Set(idxs.map((i) => districtHub.get(networks[i].district || '—')).filter((h) => h != null))];
    for (let i = 1; i < hubs.length; i++) {
      links.push({ a: hubs[i - 1], b: hubs[i], kind: 'type', label: type });
    }
  });

  return links;
}

export function buildOverview(networks) {
  const rnd = seededRandom(0x5E27);
  const nodes = [];
  const links = [];
  const rings = [];

  const ringRadius = (n) => 15 + Math.sqrt(n) * 10;
  const ringLinks = buildRingLinks(networks);

  // Super-clusters: connected components of the ring-level graph, so linked
  // rings can be laid out together instead of scattered across the canvas.
  const parent = networks.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };
  ringLinks.forEach((l) => union(l.a, l.b));
  const groups = new Map();
  networks.forEach((_, i) => {
    const r = find(i);
    (groups.get(r) || groups.set(r, []).get(r)).push(i);
  });

  // Lay out each super-cluster locally, then scatter the super-clusters.
  const clusters = [...groups.values()].sort((a, b) => b.length - a.length);
  const localPos = new Map(); // ringIdx -> { x, y } relative to its cluster
  const clusterMeta = clusters.map((members) => {
    const placed = [];
    // Biggest ring first so it anchors the middle of the cluster.
    const ordered = [...members].sort((a, b) => networks[b].size - networks[a].size);
    let field = 52 + Math.sqrt(members.length) * 62;
    ordered.forEach((ri, n) => {
      const R = ringRadius(networks[ri].size);
      const gap = 26 + rnd() * 20;
      let pos = null;
      if (n === 0) {
        pos = { x: 0, y: 0 };
      } else {
        for (let attempt = 0; attempt < 50 && !pos; attempt++) {
          const a = rnd() * Math.PI * 2;
          const d = Math.sqrt(rnd()) * field;
          const x = Math.cos(a) * d;
          const y = Math.sin(a) * d;
          if (!placed.some((q) => Math.hypot(q.x - x, q.y - y) < q.R + R + gap)) pos = { x, y };
          if (attempt === 25) field *= 1.14;
        }
        if (!pos) {
          const a = rnd() * Math.PI * 2;
          pos = { x: Math.cos(a) * field * 1.2, y: Math.sin(a) * field * 1.2 };
        }
      }
      placed.push({ ...pos, R });
      localPos.set(ri, pos);
    });
    const radius = Math.max(...placed.map((p) => Math.hypot(p.x, p.y) + p.R), 30);
    return { members, radius };
  });

  // Scatter the super-clusters themselves.
  const placedClusters = [];
  const totalArea = clusterMeta.reduce((a, c) => a + Math.PI * (c.radius + 30) ** 2, 0);
  let field = Math.sqrt((totalArea * 3.0) / Math.PI);
  clusterMeta.forEach((c, ci) => {
    const gap = 58 + rnd() * 46;
    let pos = null;
    if (ci === 0) {
      pos = { cx: 0, cy: 0 };
    } else {
      for (let attempt = 0; attempt < 70 && !pos; attempt++) {
        const a = rnd() * Math.PI * 2;
        const d = Math.sqrt(rnd()) * field;
        const cx = Math.cos(a) * d;
        const cy = Math.sin(a) * d;
        if (!placedClusters.some((q) => Math.hypot(q.cx - cx, q.cy - cy) < q.radius + c.radius + gap)) pos = { cx, cy };
        if (attempt === 35) field *= 1.12;
      }
      if (!pos) {
        const a = rnd() * Math.PI * 2;
        pos = { cx: Math.cos(a) * field * 1.2, cy: Math.sin(a) * field * 1.2 };
      }
    }
    placedClusters.push({ ...pos, radius: c.radius });
    c.cx = pos.cx;
    c.cy = pos.cy;
  });

  // Absolute ring centres.
  const ringCentre = new Map();
  clusterMeta.forEach((c) => {
    c.members.forEach((ri) => {
      const lp = localPos.get(ri) || { x: 0, y: 0 };
      ringCentre.set(ri, { cx: c.cx + lp.x, cy: c.cy + lp.y });
    });
  });

  // Nodes and within-ring (co-offending) edges.
  const hubNode = new Map(); // ringIdx -> node index of its most-connected member
  networks.forEach((net, ri) => {
    const { cx, cy } = ringCentre.get(ri) || { cx: 0, cy: 0 };
    const R = ringRadius(net.size);
    const idx = new Map();
    const base = nodes.length;
    net.members.forEach((m, i) => {
      idx.set(m.pid, base + i);
      let x;
      let y;
      if (i === 0) {
        x = cx + (rnd() - 0.5) * R * 0.2;
        y = cy + (rnd() - 0.5) * R * 0.2;
        hubNode.set(ri, base + i);
      } else {
        const a = rnd() * Math.PI * 2;
        const rr = R * (0.35 + rnd() * 0.65);
        x = cx + Math.cos(a) * rr;
        y = cy + Math.sin(a) * rr;
      }
      nodes.push({
        id: m.pid,
        label: m.name || m.names?.[0] || m.pid,
        group: m.district || '—',
        deg: m.degree || 0,
        ring: ri,
        x,
        y,
      });
    });
    net.edges.forEach((e) => {
      const s = idx.get(e.source);
      const t = idx.get(e.target);
      if (s != null && t != null) links.push({ s, t, ring: ri });
    });
    rings.push({ id: net.id, rank: net.rank, cx, cy, r: R, size: net.size, label: net.leader?.name || '' });
  });

  // Ring-to-ring edges, drawn hub to hub.
  const interLinks = ringLinks
    .map((l) => ({ s: hubNode.get(l.a), t: hubNode.get(l.b), kind: l.kind, label: l.label, a: l.a, b: l.b }))
    .filter((l) => l.s != null && l.t != null);

  // Normalise into a 0..1000 box so the renderer can fit any dataset size.
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = 960 / span;
  const offX = 20 - minX * scale;
  const offY = 20 - minY * scale;
  nodes.forEach((n) => { n.x = n.x * scale + offX; n.y = n.y * scale + offY; });
  rings.forEach((r) => { r.cx = r.cx * scale + offX; r.cy = r.cy * scale + offY; r.r *= scale; });

  const connectedRings = new Set();
  interLinks.forEach((l) => { connectedRings.add(l.a); connectedRings.add(l.b); });

  return {
    nodes,
    links,
    interLinks,
    rings,
    clusters: clusterMeta.length,
    isolated: networks.length - connectedRings.size,
  };
}
