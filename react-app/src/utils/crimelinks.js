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
export function networkToSpec(net, cap = 60) {
  const keep = new Set(net.members.slice(0, cap).map((p) => p.pid));
  const nodes = net.members
    .filter((p) => keep.has(p.pid))
    .map((p) => ({ id: p.pid, label: p.name.split(' ')[0], group: p.district }));
  const links = net.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  return { nodes, links, trimmed: net.members.length - nodes.length };
}

// ── Full-network overview ───────────────────────────────────────────────────
// Every ring laid out at once, so an officer sees the whole linkage landscape
// before drilling into one.
//
// Layout is computed here rather than simulated in the browser on each load: a
// force pass over every node at once would be slow and would tangle unrelated
// rings together.
//
// Placement is deliberately irregular. Packing the rings on a spiral (the
// obvious approach) produced a visibly mathematical pattern — evenly spaced
// dots radiating from a centre — which reads as generated rather than as real
// case data. Instead rings are scattered by dart-throwing with rejection: a
// random position is drawn, kept only if it clears everything already placed,
// and the search area grows as it fills. Members inside a ring are likewise
// placed at random angles and radii around their hub rather than on a neat
// circle. The PRNG is seeded, so the scatter is irregular but identical on
// every load — the same network never re-arranges itself under the officer.
//
// Note on topology: a "ring" here is a connected component of the co-offending
// graph, so two rings can never share a member — if they did they would be one
// ring. Overlapping rings would require a different definition (community
// detection inside a component) rather than a change to this layout.

// Deterministic PRNG (mulberry32) — irregular placement without randomness
// that changes between loads.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildOverview(networks) {
  const rnd = seededRandom(0x5E27); // fixed: same layout every load
  const nodes = [];
  const links = [];
  const rings = [];

  const ringRadius = (n) => 16 + Math.sqrt(n) * 11;

  // Scatter the ring centres. Largest first so the big clusters claim space,
  // then the long tail fills the gaps — which is what produces the uneven,
  // clumpy spread real networks have.
  const placed = [];
  const ordered = networks.map((net, i) => ({ net, i, R: ringRadius(net.size) }));
  const totalArea = ordered.reduce((a, o) => a + Math.PI * (o.R + 14) ** 2, 0);
  // Start with roughly 2.2x the area the rings need, so there is room to look
  // scattered rather than packed.
  let field = Math.sqrt((totalArea * 2.2) / Math.PI);

  ordered.forEach((o) => {
    const gap = 12 + rnd() * 16;
    let pos = null;
    for (let attempt = 0; attempt < 60 && !pos; attempt++) {
      // Uniform over the disc (sqrt keeps it from bunching at the centre).
      const a = rnd() * Math.PI * 2;
      const d = Math.sqrt(rnd()) * field;
      const cx = Math.cos(a) * d;
      const cy = Math.sin(a) * d;
      const clash = placed.some((q) => Math.hypot(q.cx - cx, q.cy - cy) < q.R + o.R + gap);
      if (!clash) pos = { cx, cy };
      if (attempt === 30) field *= 1.12; // grow the field if it is getting tight
    }
    if (!pos) {
      // Give up on separation rather than loop forever; a rare overlap reads
      // as two rings sitting close, which is fine.
      const a = rnd() * Math.PI * 2;
      pos = { cx: Math.cos(a) * field * 1.15, cy: Math.sin(a) * field * 1.15 };
    }
    placed.push({ cx: pos.cx, cy: pos.cy, R: o.R, o });
  });

  placed.forEach(({ cx, cy, R, o }) => {
    const { net, i: ri } = o;
    const members = net.members;
    const idx = new Map();
    const base = nodes.length;

    members.forEach((m, i) => {
      idx.set(m.pid, base + i);
      // Members are pre-sorted by degree, so member 0 is the hub and anchors
      // the centre; the rest sit at random angles and depths around it, which
      // gives each ring its own irregular shape.
      let x;
      let y;
      if (i === 0) {
        x = cx + (rnd() - 0.5) * R * 0.22;
        y = cy + (rnd() - 0.5) * R * 0.22;
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

  return { nodes, links, rings };
}
