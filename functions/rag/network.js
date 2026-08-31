'use strict';

/**
 * The co-offending network, server-side.
 *
 * Two people are linked when they appear as accused in the SAME case, and the
 * same person is followed across cases by their global PersonID. The Crime
 * Links tab has computed this in the browser for a while; this module exists so
 * the ASSISTANT can answer from it too. Until now it could not: ZCQL is
 * single-table with no joins, so "who has this person offended with" — the most
 * natural question an officer can ask about an accused — had no route to an
 * answer at all.
 *
 * Why this and not a graph database. The graph is ~2,400 people and ~1,700
 * links. Every operation below is a breadth-first walk over that, which is
 * microseconds; a graph database is built for a scale six orders of magnitude
 * larger and would add a second datastore, another credential and another
 * outage to a platform whose whole point is that it runs on Catalyst alone.
 * Revisit that if the real statewide graph ever outgrows memory.
 *
 * Everything returned here names people, so every caller must pass results
 * through the clearance filter — tools.js does that at dispatch.
 */

const PAGE = 300; // the Data Store's per-query ceiling
const TTL_MS = 10 * 60 * 1000;

let cache = null; // { graph, builtAt }

async function pageAll(app, sql) {
  const out = [];
  for (let off = 0; off < 40000; off += PAGE) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await app.zcql().executeZCQLQuery(`${sql} LIMIT ${off}, ${PAGE}`);
    const rows = (raw || []).map((r) => Object.values(r)[0] || {});
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Build the graph. One pass over Accused gives every person and the cases they
 * appear in; a second over CaseMaster labels those cases so a ring can be
 * described by what it actually does rather than by an id.
 */
async function build(app) {
  const accused = await pageAll(app, 'SELECT PersonID, CaseMasterID, AccusedName, AgeYear FROM Accused');

  const people = new Map(); // personId -> { id, name, ages:Set, cases:Set }
  const caseMembers = new Map(); // caseId -> Set(personId)

  for (const r of accused) {
    const pid = String(r.PersonID || '').trim();
    const cid = String(r.CaseMasterID || '').trim();
    if (!pid || !cid) continue;
    if (!people.has(pid)) people.set(pid, { id: pid, name: r.AccusedName || '(unnamed)', ages: new Set(), cases: new Set() });
    const p = people.get(pid);
    if (r.AgeYear) p.ages.add(Number(r.AgeYear));
    p.cases.add(cid);
    if (!caseMembers.has(cid)) caseMembers.set(cid, new Set());
    caseMembers.get(cid).add(pid);
  }

  // Adjacency: co-accused in at least one shared case, remembering which.
  const adj = new Map(); // personId -> Map(otherId -> Set(caseId))
  const link = (a, b, cid) => {
    if (!adj.has(a)) adj.set(a, new Map());
    if (!adj.get(a).has(b)) adj.get(a).set(b, new Set());
    adj.get(a).get(b).add(cid);
  };
  for (const [cid, members] of caseMembers) {
    const list = [...members];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) { link(list[i], list[j], cid); link(list[j], list[i], cid); }
    }
  }

  // Connected components — the "rings". Union-find over the adjacency above.
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const id of people.keys()) parent.set(id, id);
  for (const [a, nbrs] of adj) for (const b of nbrs.keys()) { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); }
  const rings = new Map(); // rootId -> [personId]
  for (const id of people.keys()) {
    const root = find(id);
    if (!rings.has(root)) rings.set(root, []);
    rings.get(root).push(id);
  }

  // Case labels, best-effort: a ring is far more useful described as "15 people,
  // mostly vehicle theft, Kalaburagi" than as a component id.
  let caseInfo = new Map();
  try {
    const cases = await pageAll(app, 'SELECT CaseMasterID, CrimeMajorHeadID, PoliceStationID, CrimeRegisteredDate FROM CaseMaster');
    caseInfo = new Map(cases.map((c) => [String(c.CaseMasterID), c]));
  } catch {
    /* labels are a nicety; the graph itself still answers */
  }

  return { people, adj, rings, findRoot: find, caseMembers, caseInfo };
}

async function graph(app) {
  if (cache && Date.now() - cache.builtAt < TTL_MS) return cache.graph;
  const g = await build(app);
  cache = { graph: g, builtAt: Date.now() };
  return g;
}

/** Test seam — lets a suite install a graph without a Data Store. */
function _setCache(g) { cache = g ? { graph: g, builtAt: Date.now() } : null; }

// ── Resolving who the officer meant ────────────────────────────────────────
// An officer says a name, not a PersonID. An ambiguous name must come back as
// a question rather than a guess: answering about the wrong person is worse
// than answering about nobody.
function resolve(g, who) {
  const needle = String(who || '').trim().toLowerCase();
  if (!needle) return { error: 'Give a person name or PersonID.' };
  if (g.people.has(needle)) return { person: g.people.get(needle) };
  const exactId = [...g.people.keys()].find((k) => k.toLowerCase() === needle);
  if (exactId) return { person: g.people.get(exactId) };

  const hits = [...g.people.values()].filter((p) => String(p.name).toLowerCase().includes(needle));
  if (!hits.length) return { error: `No accused person matching "${who}".` };
  if (hits.length > 1) {
    return {
      ambiguous: hits.slice(0, 10).map((p) => ({ person_id: p.id, name: p.name, cases: p.cases.size })),
      note: `${hits.length} people match "${who}". Ask which, or pass the person_id.`,
    };
  }
  return { person: hits[0] };
}

const describe = (g, p) => ({
  person_id: p.id,
  name: p.name,
  age: p.ages.size ? Math.max(...p.ages) : null,
  case_count: p.cases.size,
  co_accused_count: g.adj.has(p.id) ? g.adj.get(p.id).size : 0,
});

// ── Operations ─────────────────────────────────────────────────────────────

function neighbours(g, p, depth) {
  const maxDepth = Math.min(Math.max(Number(depth) || 1, 1), 3);
  const seen = new Map([[p.id, 0]]);
  const queue = [p.id];
  const out = [];
  while (queue.length) {
    const cur = queue.shift();
    const d = seen.get(cur);
    if (d >= maxDepth) continue;
    for (const [nb, cases] of (g.adj.get(cur) || new Map())) {
      if (seen.has(nb)) continue;
      seen.set(nb, d + 1);
      queue.push(nb);
      const n = g.people.get(nb);
      out.push({ ...describe(g, n), hops: d + 1, ...(d === 0 ? { shared_cases: [...cases] } : { via: g.people.get(cur).name }) });
    }
  }
  out.sort((a, b) => a.hops - b.hops || b.case_count - a.case_count);
  return { person: describe(g, p), depth: maxDepth, connected: out.length, people: out.slice(0, 40) };
}

function path(g, a, b) {
  if (a.id === b.id) return { same_person: true };
  const prev = new Map([[a.id, null]]);
  const queue = [a.id];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === b.id) break;
    for (const nb of (g.adj.get(cur) || new Map()).keys()) {
      if (prev.has(nb)) continue;
      prev.set(nb, cur);
      queue.push(nb);
    }
  }
  if (!prev.has(b.id)) {
    return { connected: false, note: `${a.name} and ${b.name} have no co-offending path — they never share a case, directly or through anyone else.` };
  }
  const chain = [];
  for (let at = b.id; at !== null; at = prev.get(at)) chain.unshift(at);
  const steps = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    steps.push({
      from: g.people.get(chain[i]).name,
      to: g.people.get(chain[i + 1]).name,
      shared_cases: [...(g.adj.get(chain[i]).get(chain[i + 1]) || [])],
    });
  }
  return { connected: true, degrees_of_separation: steps.length, path: chain.map((id) => describe(g, g.people.get(id))), links: steps };
}

function ring(g, p) {
  const members = g.rings.get(g.findRoot(p.id)) || [p.id];
  const cases = new Set();
  members.forEach((id) => g.people.get(id).cases.forEach((c) => cases.add(c)));
  const heads = {};
  const stations = {};
  for (const c of cases) {
    const info = g.caseInfo.get(String(c));
    if (!info) continue;
    if (info.CrimeMajorHeadID != null) heads[info.CrimeMajorHeadID] = (heads[info.CrimeMajorHeadID] || 0) + 1;
    if (info.PoliceStationID != null) stations[info.PoliceStationID] = (stations[info.PoliceStationID] || 0) + 1;
  }
  const top = (o) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, n]) => ({ id: k, cases: n }));
  const ranked = members
    .map((id) => describe(g, g.people.get(id)))
    .sort((x, y) => y.co_accused_count - x.co_accused_count || y.case_count - x.case_count);
  return {
    ring_size: members.length,
    total_cases: cases.size,
    // Most-connected first. Advisory only — degree is a lead, never a finding.
    members: ranked.slice(0, 40),
    dominant_crime_head_ids: top(heads),
    top_station_ids: top(stations),
    ...(members.length > 40 ? { note: `${members.length} members, showing the 40 most connected.` } : {}),
  };
}

function mostConnected(g, limit) {
  const n = Math.min(Math.max(Number(limit) || 10, 1), 40);
  return {
    people: [...g.people.values()]
      .map((p) => describe(g, p))
      .sort((a, b) => b.co_accused_count - a.co_accused_count || b.case_count - a.case_count)
      .slice(0, n),
    note: 'Ranked by number of distinct co-accused. A lead for review, not a finding.',
  };
}

async function run(app, input) {
  const g = await graph(app);
  const op = String((input && input.operation) || '').trim();

  if (op === 'most_connected') return mostConnected(g, input.limit);

  const first = resolve(g, input && input.person);
  if (first.error || first.ambiguous) return first;

  if (op === 'neighbours') return neighbours(g, first.person, input.depth);
  if (op === 'ring') return ring(g, first.person);
  if (op === 'path') {
    const second = resolve(g, input && input.other_person);
    if (second.error || second.ambiguous) return second;
    return path(g, first.person, second.person);
  }
  return { error: `Unknown operation "${op}". Use neighbours, path, ring or most_connected.` };
}

module.exports = { run, graph, resolve, neighbours, path, ring, mostConnected, _setCache };
