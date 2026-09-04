/* The shape of the money-flow network.
 *
 * It came out as a row of identical stars: each flagged entity in the middle
 * of its own private ring of accounts, nothing joining one star to the next,
 * every node the same distance from its neighbours. Regular, and therefore
 * useless — the thing worth seeing on a money graph is where two chains MEET,
 * and by construction none of them ever did.
 *
 * Three causes, all in the data rather than the drawing:
 *   · every entity drew its accounts from 9,000 slots keyed on itself, so two
 *     of them almost never touched the same account;
 *   · principals never dealt with each other directly;
 *   · the map drew one hop, and the first hop of a laundering chain is the
 *     boring half.
 *
 * These assert the properties that make the picture read as measured rather
 * than drawn. They are deliberately about shape — hubs, reuse, connectedness,
 * spread — because the exact node count is a tuning decision and the shape is
 * not.
 */
const N_CASES = 4000;
const rnd = (() => { let a = 99; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; })();
const HEADS = ['Economic Offences', 'Cyber Crime', 'Crimes Against Property', 'Body Offences', 'Fraud'];

const mockCases = [];
for (let i = 1; i <= N_CASES; i++) {
  mockCases.push({
    CaseMasterID: i, CrimeNo: `CR${i}`,
    CrimeRegisteredDate: `2024-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')} 10:00:00`,
    PoliceStationID: 1, CrimeMajorHeadID: 1 + Math.floor(rnd() * HEADS.length),
    CrimeMinorHeadID: 1, CaseStatusID: 1, GravityOffenceID: 2,
  });
}
const mockAccused = [];
let am = 1;
for (let i = 1; i <= N_CASES; i++) {
  const n = 1 + Math.floor(rnd() * 3);
  for (let j = 0; j < n; j++) {
    mockAccused.push({
      AccusedMasterID: am++, CaseMasterID: i,
      PersonID: `P${1 + Math.floor(rnd() * 1400)}`,
      AccusedName: `A. Name${Math.floor(rnd() * 900)}`, AgeYear: 30, GenderID: 1,
    });
  }
}
jest.mock('../utils/datastore', () => ({
  fetchSharedCases: () => Promise.resolve(mockCases),
  fetchSharedAccused: () => Promise.resolve(mockAccused),
  fetchSnapshotTable: (t) => Promise.resolve(({
    Unit: [{ UnitID: 1, UnitName: 'PS One', DistrictID: 1 }],
    District: [{ DistrictID: 1, DistrictName: 'Kodagu' }],
    CrimeHead: HEADS.map((h, i) => ({ CrimeHeadID: i + 1, CrimeGroupName: h })),
  })[t] || []),
  runQuery: () => Promise.resolve([]), pageQuery: () => Promise.resolve([]),
  CASE_COLUMNS: '', ACCUSED_COLUMNS: '',
}));

const fin = require('../utils/financial');

let model;
let map;
let degree;
beforeAll(async () => {
  model = fin.buildFinancialTrails(await fin.fetchFinancialData());
  map = fin.buildMoneyMap(model.moneyGraph.nodes, model.moneyGraph.flows);
  degree = map.nodes.map((_, i) => 0);
  map.links.forEach((l) => { degree[l.s] += 1; degree[l.t] += 1; });
});

test('it is one network, not a row of separate stars', () => {
  // Every flagged entity used to be its own island. Some satellites are fine
  // and real; a dozen identical disconnected stars is not.
  expect(map.clusters).toBeLessThan(map.entities / 2);
});

test('accounts are shared — the same mule serves more than one person', () => {
  // The finding a money map exists for: two chains running through one
  // account. If no account has more than one person behind it, there is
  // nothing on the map worth looking at.
  const people = new Set(map.nodes.filter((n) => n.kind === 'Entity' || n.kind === 'Counterparty').map((n) => n.id));
  const backers = new Map();
  map.links.forEach((l) => {
    const [a, b] = [map.nodes[l.s], map.nodes[l.t]];
    [[a, b], [b, a]].forEach(([acct, other]) => {
      if (acct.kind !== 'Mule' && acct.kind !== 'Shell') return;
      if (!people.has(other.id)) return;
      const set = backers.get(acct.id);
      if (set) set.add(other.id); else backers.set(acct.id, new Set([other.id]));
    });
  });
  const shared = [...backers.values()].filter((v) => v.size > 1).length;
  expect(shared).toBeGreaterThan(0);
});

test('degree is lopsided — a few hubs and a long tail, not one shape repeated', () => {
  const sorted = [...degree].sort((a, b) => b - a);
  const median = sorted[Math.floor(sorted.length / 2)];
  // A field of identical stars has every centre at the same degree and every
  // leaf at 1. A real one has a heavy head.
  expect(sorted[0]).toBeGreaterThanOrEqual(8);
  expect(sorted[0]).toBeGreaterThan(median * 3);
  expect(median).toBeLessThanOrEqual(3);
});

test('the map reaches past the first hop', () => {
  // A one-hop map cannot contain an account-to-account transfer, because both
  // ends would have to be a flagged entity's direct counterparty.
  const isAccount = (n) => n.kind === 'Mule' || n.kind === 'Shell';
  const accountToAccount = map.links.filter(
    (l) => isAccount(map.nodes[l.s]) && isAccount(map.nodes[l.t])
  );
  expect(accountToAccount.length).toBeGreaterThan(0);
});

test('principals deal with each other directly, and only when co-charged', () => {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const person = (n) => n.kind === 'Entity' || n.kind === 'Counterparty';
  const direct = map.links.filter((l) => person(map.nodes[l.s]) && person(map.nodes[l.t]));
  expect(direct.length).toBeGreaterThan(0);

  // Every one of those pairs must actually appear in a shared FIR — this is
  // the one edge in the ledger that is not invented, so it has to hold.
  const coAccused = new Set();
  const byCase = new Map();
  mockAccused.forEach((a) => {
    const list = byCase.get(a.CaseMasterID);
    if (list) { if (!list.includes(a.PersonID)) list.push(a.PersonID); }
    else byCase.set(a.CaseMasterID, [a.PersonID]);
  });
  byCase.forEach((people) => {
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        coAccused.add([people[i], people[j]].sort().join('|'));
      }
    }
  });
  direct.forEach((l) => {
    const key = [map.nodes[l.s].id, map.nodes[l.t].id].sort().join('|');
    expect(coAccused.has(key)).toBe(true);
  });
  void byId;
});

test('no account ever transfers to itself', () => {
  // The shared pool concentrates draws on a few accounts, so two consecutive
  // draws landed on the SAME one often enough to matter: layering chains hopped
  // to the account they were already at, and a "fan-in from many accounts" was
  // one account four times. The map silently dropped the self-loops, which is
  // why no layering chain ever appeared on it.
  model.moneyGraph.flows.forEach((f) => expect(f.from).not.toBe(f.to));
  map.links.forEach((l) => expect(l.s).not.toBe(l.t));
});

test('a fan-in really is from several DIFFERENT accounts', () => {
  const fanIn = model.alerts.filter((a) => a.typologies.includes('fanIn'));
  expect(fanIn.length).toBeGreaterThan(0);
  // inDistinct counts distinct senders; the typology is meaningless if the
  // generator can satisfy it with one account counted four times.
  fanIn.forEach((a) => expect(a.inDistinct).toBeGreaterThanOrEqual(4));
});

test('the whole thing still lays out without overlapping nodes', () => {
  let touching = 0;
  for (let i = 0; i < map.nodes.length; i++) {
    for (let j = i + 1; j < map.nodes.length; j++) {
      const a = map.nodes[i];
      const b = map.nodes[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < (a.r + b.r) * 0.7) touching++;
    }
  }
  expect(touching).toBe(0);
});

test('the ledger is still mostly account traffic, not principals paying each other', () => {
  const p2p = model.moneyGraph.flows.filter((f) => !/^(SHELL|MULE)/.test(f.from) && !/^(SHELL|MULE)/.test(f.to));
  expect(p2p.length).toBeLessThan(model.moneyGraph.flows.length / 2);
});
