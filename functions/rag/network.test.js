// Co-offending network. Run: node functions/rag/network.test.js
//
// The graph answers questions about who a person offends with, which is a
// sentence an officer may act on. Three properties matter most:
//   • a link means SHARING A CASE FILE and nothing more — it must never be
//     invented where none exists;
//   • an ambiguous name comes back as a choice, never as a guess at which
//     Ramesh was meant;
//   • every list of people leaves dispatch through the clearance filter.
const net = require('./network');
const tools = require('./tools');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

// A small hand-built graph, so the shapes are checkable by eye:
//
//   Asha ── C1 ── Bhim ── C2 ── Chetan        Divya ── C4 ── Esha
//     └──── C3 ──────────┘
//
// Asha-Bhim share two cases; Chetan hangs off Bhim; Divya/Esha are a separate
// ring that must never connect to the first.
function fixture() {
  const rows = [
    ['P1', 'C1', 'Asha Rao'], ['P2', 'C1', 'Bhim Singh'],
    ['P2', 'C2', 'Bhim Singh'], ['P3', 'C2', 'Chetan Rao'],
    ['P1', 'C3', 'Asha Rao'], ['P2', 'C3', 'Bhim Singh'],
    ['P4', 'C4', 'Divya Nair'], ['P5', 'C4', 'Esha Nair'],
  ];
  const people = new Map();
  const caseMembers = new Map();
  for (const [pid, cid, name] of rows) {
    if (!people.has(pid)) people.set(pid, { id: pid, name, ages: new Set(), cases: new Set() });
    people.get(pid).cases.add(cid);
    if (!caseMembers.has(cid)) caseMembers.set(cid, new Set());
    caseMembers.get(cid).add(pid);
  }
  const adj = new Map();
  const link = (a, b, c) => {
    if (!adj.has(a)) adj.set(a, new Map());
    if (!adj.get(a).has(b)) adj.get(a).set(b, new Set());
    adj.get(a).get(b).add(c);
  };
  for (const [cid, m] of caseMembers) {
    const l = [...m];
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) { link(l[i], l[j], cid); link(l[j], l[i], cid); }
  }
  const parent = new Map([...people.keys()].map((k) => [k, k]));
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  for (const [a, nb] of adj) for (const b of nb.keys()) { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); }
  const rings = new Map();
  for (const id of people.keys()) {
    const r = find(id);
    if (!rings.has(r)) rings.set(r, []);
    rings.get(r).push(id);
  }
  return { people, adj, rings, findRoot: find, caseMembers, caseInfo: new Map() };
}

const g = fixture();
net._setCache(g);
const app = {}; // never touched: the cache is warm

(async () => {
  // ── Direct links ─────────────────────────────────────────────────────────
  const nb = await net.run(app, { operation: 'neighbours', person: 'Asha' });
  check('a person\'s co-accused are found', nb.people.map((p) => p.name).includes('Bhim Singh'));
  check('a one-hop neighbour names the cases that link them',
    nb.people.find((p) => p.name === 'Bhim Singh').shared_cases.sort().join() === 'C1,C3');
  check('someone two cases away is not a one-hop neighbour',
    !nb.people.some((p) => p.name === 'Chetan Rao'));

  const deep = await net.run(app, { operation: 'neighbours', person: 'Asha', depth: 2 });
  check('depth 2 reaches the second hop', deep.people.some((p) => p.name === 'Chetan Rao' && p.hops === 2));
  check('a second-hop result says who it came through',
    deep.people.find((p) => p.name === 'Chetan Rao').via === 'Bhim Singh');

  // ── Paths ────────────────────────────────────────────────────────────────
  const pth = await net.run(app, { operation: 'path', person: 'Asha', other_person: 'Chetan' });
  check('a path between two connected people is found', pth.connected === true);
  check('the path reports its true length', pth.degrees_of_separation === 2);
  check('the path names the cases each step rests on', pth.links[0].shared_cases.length > 0);

  // The property that matters most: no invented connection.
  const none = await net.run(app, { operation: 'path', person: 'Asha', other_person: 'Divya' });
  check('two people in separate rings are reported as UNCONNECTED', none.connected === false);
  check('and it says so in words an officer can read', /no co-offending path/i.test(none.note));

  // ── Rings ────────────────────────────────────────────────────────────────
  const r = await net.run(app, { operation: 'ring', person: 'Chetan' });
  check('a ring holds everyone reachable', r.ring_size === 3);
  check('a ring does not leak members of another ring',
    !r.members.some((m) => m.name === 'Divya Nair'));
  const r2 = await net.run(app, { operation: 'ring', person: 'Divya' });
  check('the separate ring stays separate', r2.ring_size === 2);

  // ── Ranking ──────────────────────────────────────────────────────────────
  const top = await net.run(app, { operation: 'most_connected' });
  check('the most-connected person ranks first', top.people[0].name === 'Bhim Singh');
  check('ranking is framed as a lead, not a finding', /lead/i.test(top.note));

  // ── Ambiguity ────────────────────────────────────────────────────────────
  const amb = await net.run(app, { operation: 'neighbours', person: 'Rao' });
  check('an ambiguous name returns the candidates rather than guessing',
    Array.isArray(amb.ambiguous) && amb.ambiguous.length === 2);
  check('it does not answer about either of them', amb.people === undefined);

  const missing = await net.run(app, { operation: 'neighbours', person: 'Nobody At All' });
  check('an unknown name is an error, not an empty network', /No accused person/i.test(missing.error));

  // ── Dispatch: clearance ──────────────────────────────────────────────────
  // A tool result becomes prompt text, so an unfiltered one is the same
  // disclosure as printing the record. A caller with no clearance must not
  // receive names.
  const asNobody = await tools.run('traverse_network', { operation: 'most_connected' }, { app, role: null });
  check('results pass through the clearance filter at dispatch',
    Array.isArray(asNobody._redactions));
  const asAdmin = await tools.run('traverse_network', { operation: 'most_connected' }, { app, role: 'admin' });
  check('an admin still gets the network', asAdmin.people.length > 0);

  // ── Schema ───────────────────────────────────────────────────────────────
  const def = tools.DEFINITIONS.find((d) => d.name === 'traverse_network');
  check('the tool is registered', !!def);
  check('it tells the model why query_records cannot do this',
    /single-table|no joins/i.test(def.description));
  check('it declares its operations', def.input_schema.properties.operation.enum.length === 4);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
