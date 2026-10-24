// Components drawn from tool results rather than retyped by the model.
// Run: node functions/rag/widgets.test.js

const { fromTool, merge } = require('./widgets');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

// ── Ring → network graph ─────────────────────────────────────────────────────
const ring = fromTool('traverse_network', { operation: 'ring' }, {
  ring_size: 3,
  members: [{ person_id: 'P1', name: 'Ravi' }, { person_id: 'P2', name: 'Suresh' }, { person_id: 'P3', name: 'Mahesh' }],
  edges: [{ source: 'P1', target: 'P2' }, { source: 'P2', target: 'P3' }],
});
check('ring draws a network graph', ring && ring.type === 'network-graph');
check('ring keeps every member as a node', ring.nodes.length === 3);
check('ring keeps the edges exactly', ring.links.length === 2 && ring.links[0].source === 'P1');
check('grounded flag is set', ring.grounded === true);

// A member withheld for clearance must not come back as an edge endpoint.
const withheld = fromTool('traverse_network', { operation: 'ring' }, {
  ring_size: 3,
  members: [{ person_id: 'P1', name: 'Ravi' }, { person_id: 'P2', name: 'Suresh' }],
  edges: [{ source: 'P1', target: 'P2' }, { source: 'P2', target: 'P9' }],
});
check('edges to a withheld person are dropped', withheld.links.length === 1);

check('a ring with no edges draws nothing',
  fromTool('traverse_network', { operation: 'ring' }, { ring_size: 2, members: [{ person_id: 'A' }, { person_id: 'B' }], edges: [] }) === null);

const nb = fromTool('traverse_network', { operation: 'neighbours' }, {
  person: { person_id: 'P1', name: 'Ravi' },
  people: [{ person_id: 'P2', name: 'Suresh', hops: 1 }],
  edges: [{ source: 'P1', target: 'P2' }],
});
check('neighbours includes the person themself', nb.nodes.some((n) => n.id === 'P1'));

const path = fromTool('traverse_network', { operation: 'path' }, {
  path: [{ person_id: 'A', name: 'A' }, { person_id: 'B', name: 'B' }, { person_id: 'C', name: 'C' }],
});
check('path draws consecutive links', path.links.length === 2 && path.links[1].source === 'B');

// ── Obligations → checklist ─────────────────────────────────────────────────
const ob = fromTool('case_obligations', {}, {
  total: 2,
  obligations: [
    { case: 'CR-1', title: 'File chargesheet', finding: 'Accused in custody', severity: 'critical', days_remaining: 4 },
    { case: 'CR-2', title: 'Seize CCTV', finding: 'Recorder overwrites', severity: 'high' },
  ],
});
check('obligations draw a checklist', ob && ob.type === 'checklist' && ob.items.length === 2);
check('checklist carries the countdown', ob.items[0].meta === 'CR-1 · 4 day(s) left');
check('a single obligation stays prose', fromTool('case_obligations', {}, { obligations: [{ title: 'x' }] }) === null);

// ── Grouped counts → chart ──────────────────────────────────────────────────
const byDistrict = fromTool('query_records', {}, {
  rows: [{ DistrictName: 'Mysuru', count: '12' }, { DistrictName: 'Udupi', count: '7' }, { DistrictName: 'Kolar', count: '3' }],
});
check('district counts draw a geo-map', byDistrict && byDistrict.type === 'geo-map');
check('numeric strings become numbers', byDistrict.data[0].value === 12);

const byHead = fromTool('query_records', {}, {
  rows: [{ CrimeHead: 'Theft', total: 5 }, { CrimeHead: 'Murder', total: 9 }, { CrimeHead: 'Fraud', total: 2 }],
});
check('category counts draw a ranked bar chart', byHead.type === 'bar-chart' && byHead.data[0].label === 'Murder');

const byYear = fromTool('query_records', {}, {
  rows: [{ Year: '2025', cases: 30 }, { Year: '2023', cases: 10 }, { Year: '2024', cases: 20 }],
});
check('years draw a line chart in time order', byYear.type === 'line-chart' && byYear.data[0].label === '2023');

check('raw records are not a chart', fromTool('query_records', {}, {
  rows: [{ CaseMasterID: '1', CrimeNo: 'A', BriefFacts: 'x' }, { CaseMasterID: '2', CrimeNo: 'B', BriefFacts: 'y' }, { CaseMasterID: '3', CrimeNo: 'C', BriefFacts: 'z' }],
}) === null);
check('ids alone are not a measure', fromTool('query_records', {}, {
  rows: [{ Name: 'a', CrimeMajorHeadID: '3' }, { Name: 'b', CrimeMajorHeadID: '4' }, { Name: 'c', CrimeMajorHeadID: '5' }],
}) === null);
check('a tool error draws nothing', fromTool('query_records', {}, { error: 'bad' }) === null);

// ── Merge ───────────────────────────────────────────────────────────────────
const merged = merge([ring], [{ type: 'network-graph', nodes: [] }, { type: 'bar-chart', data: [] }]);
check('the model\'s copy of a grounded type is dropped', merged.filter((c) => c.type === 'network-graph').length === 1 && merged[0].grounded);
check('other model components survive', merged.some((c) => c.type === 'bar-chart'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
