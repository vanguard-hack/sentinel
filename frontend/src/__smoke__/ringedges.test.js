/* Ring edges, assembled the fast way.
 *
 * The ring builder used to rescan the WHOLE co-offending edge list once per
 * ring and split every key string again on each pass — 536 rings against every
 * edge at the deployed size, quadratic in the number of rings, and the single
 * most expensive thing on the Crime Links tab.
 *
 * Edges are now bucketed by component root in one pass. That is only sound
 * because a ring IS a connected component of the co-offending graph, so both
 * ends of any edge always land in the same one. A wrong bucket would put one
 * gang's links inside another — an error an investigator could not see and
 * would have no reason to doubt. So this runs the real builder over a real
 * accused list and checks the result against the definition, not the shortcut.
 */
const mockAccused = [];
const mockCases = [];

// Three deliberate shapes: two separate gangs that must never share an edge, a
// pair (too small to be a ring), and a lone offender.
const GANGS = [
  ['P1', 'P2', 'P3', 'P4'],
  ['P5', 'P6', 'P7'],
];
let caseId = 0;
const addCase = (people) => {
  caseId += 1;
  mockCases.push({
    CaseMasterID: caseId, CrimeNo: `CR/${caseId}`,
    CrimeRegisteredDate: `2025-0${1 + (caseId % 9)}-10 09:00:00`,
    PoliceStationID: 1, CrimeMajorHeadID: 1, CrimeMinorHeadID: 1,
    CaseStatusID: 1, GravityOffenceID: 2,
  });
  people.forEach((p, i) => mockAccused.push({
    AccusedMasterID: `${caseId}-${i}`, CaseMasterID: caseId,
    PersonID: p, AccusedName: `N. ${p}`, AgeYear: 30, GenderID: 1,
  }));
};
// Gang 1: a chain plus a shared job, so it has more than a spanning tree.
addCase(['P1', 'P2']); addCase(['P2', 'P3']); addCase(['P3', 'P4']); addCase(['P1', 'P4']);
// Gang 2: all three together twice, so one edge carries weight 2.
addCase(['P5', 'P6', 'P7']); addCase(['P5', 'P6']);
// Below the ring threshold, and a solo offender.
addCase(['P8', 'P9']); addCase(['P10']);

jest.mock('../utils/datastore', () => ({
  fetchSharedCases: () => Promise.resolve(mockCases),
  fetchSharedAccused: () => Promise.resolve(mockAccused),
  fetchSnapshotTable: (t) => Promise.resolve(({
    Unit: [{ UnitID: 1, UnitName: 'PS One', DistrictID: 1 }],
    District: [{ DistrictID: 1, DistrictName: 'Kodagu' }],
    CrimeHead: [{ CrimeHeadID: 1, CrimeGroupName: 'Property' }],
    CrimeSubHead: [{ CrimeSubHeadID: 1, CrimeHeadName: 'Theft' }],
    CaseStatusMaster: [{ CaseStatusID: 1, CaseStatusName: 'Open' }],
  })[t] || []),
  runQuery: () => Promise.resolve([]),
  pageQuery: () => Promise.resolve([]),
  CASE_COLUMNS: '', ACCUSED_COLUMNS: '',
}));

const { fetchCrimeNetwork } = require('../utils/crimelinks');

let net;
beforeAll(async () => { net = await fetchCrimeNetwork(); });

test('a component of three or more is a ring; smaller groups are not', () => {
  expect(net.networks.map((r) => r.size).sort((a, b) => b - a)).toEqual([4, 3]);
});

test('every edge on a ring joins two of ITS OWN members', () => {
  net.networks.forEach((ring) => {
    const members = new Set(ring.members.map((m) => m.pid));
    expect(ring.edges.length).toBeGreaterThan(0);
    ring.edges.forEach((e) => {
      expect(members.has(e.source)).toBe(true);
      expect(members.has(e.target)).toBe(true);
    });
  });
});

test('no edge is dropped and none is duplicated across rings', () => {
  // The definition: one edge per co-offending pair, and every pair belongs to
  // exactly one ring or to none (a pair too small to be a ring).
  const drawn = net.networks.flatMap((r) => r.edges.map((e) => [e.source, e.target].sort().join('|')));
  expect(new Set(drawn).size).toBe(drawn.length);          // no duplicates
  expect(drawn.sort()).toEqual(['P1|P2', 'P1|P4', 'P2|P3', 'P3|P4', 'P5|P6', 'P5|P7', 'P6|P7'].sort());
});

test('an edge carries how many cases the pair share', () => {
  const gang2 = net.networks.find((r) => r.size === 3);
  const p5p6 = gang2.edges.find((e) => [e.source, e.target].sort().join('|') === 'P5|P6');
  expect(p5p6.weight).toBe(2);   // they appear together in two FIRs
  const p6p7 = gang2.edges.find((e) => [e.source, e.target].sort().join('|') === 'P6|P7');
  expect(p6p7.weight).toBe(1);
});

test('the two gangs stay separate — no edge crosses between them', () => {
  const gang1 = new Set(GANGS[0]);
  net.networks.forEach((ring) => {
    const inG1 = ring.members.filter((m) => gang1.has(m.pid)).length;
    expect(inG1 === 0 || inG1 === ring.size).toBe(true);
  });
});

test('a ring is identified by its component, so its id is stable', () => {
  net.networks.forEach((ring) => expect(ring.id).toBeTruthy());
  expect(new Set(net.networks.map((r) => r.id)).size).toBe(net.networks.length);
});
