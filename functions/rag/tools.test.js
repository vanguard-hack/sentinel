// Assistant tools: schemas, dispatch, and the clearance filter that has to run
// on every result. Run: node functions/rag/tools.test.js

const tools = require('./tools');
const redaction = require('./redaction');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};
const run = (name, input, deps) => tools.run(name, input, deps);

// ── Schemas ───────────────────────────────────────────────────────────────
check('every tool declares a name, a description and a schema',
  tools.DEFINITIONS.every((d) => d.name && d.description && d.input_schema));
check('every tool marks its required inputs',
  tools.DEFINITIONS.every((d) => Array.isArray(d.input_schema.required) && d.input_schema.required.length));
check('the record tool warns the model that joins do not work',
  /join/i.test(tools.DEFINITIONS.find((d) => d.name === 'query_records').description));
check('it also tells the model how to relate two tables instead',
  /IN clause|read the IDs/i.test(tools.DEFINITIONS.find((d) => d.name === 'query_records').description));

// ── Reference lookup ──────────────────────────────────────────────────────
const districts = tools.lookupReference({ kind: 'districts' });
check('a reference list comes back with rows', Array.isArray(districts.rows) && districts.rows.length > 0);
const belagavi = tools.lookupReference({ kind: 'districts', match: 'belagavi' });
check('matching narrows the list', belagavi.matched > 0 && belagavi.matched < districts.rows.length + 1);
check('an unknown list is refused with the valid options',
  /Unknown reference list/.test(tools.lookupReference({ kind: 'nonsense' }).error || ''));
const employees = tools.lookupReference({ kind: 'employees' });
check('a long list is capped and says so, rather than filling the prompt',
  employees.rows.length <= tools.MAX_ROWS && (employees.matched <= tools.MAX_ROWS || /Narrow with/.test(employees.note)));

// ── Data Store: the validator is not bypassable ───────────────────────────
const fakeApp = (rows) => ({ zcql: () => ({ executeZCQLQuery: async () => rows }) });

(async () => {
  const joined = await run('query_records',
    { zcql: 'SELECT * FROM CaseMaster JOIN Accused ON 1=1', purpose: 'x' },
    { app: fakeApp([]), role: 'admin' });
  check('a join is rejected by the same validator the single-lane path uses', !!joined.error);
  check('the rejection tells the model how to recover', /IN clause|separately/i.test(joined.hint || ''));

  const notSelect = await run('query_records',
    { zcql: 'DELETE FROM CaseMaster', purpose: 'x' },
    { app: fakeApp([]), role: 'admin' });
  check('a non-SELECT statement never reaches the Data Store', !!notSelect.error);

  // ── Clearance: the rule that matters most ───────────────────────────────
  // A tool result goes straight into the model's context, so an unfiltered one
  // is the same disclosure as printing the record.
  const sensitive = [{
    CaseMaster: {
      CaseMasterID: 1, CrimeNo: '144011004202300002',
      BriefFacts: 'Complainant Meena Rao, Aadhaar 4321 8765 9012, phone 9845012345.',
    },
  }];
  const asAdmin = await run('query_records',
    { zcql: 'SELECT CaseMaster.CrimeNo FROM CaseMaster LIMIT 10', purpose: 'x' },
    { app: fakeApp(sensitive), role: 'admin' });
  const asNobody = await run('query_records',
    { zcql: 'SELECT CaseMaster.CrimeNo FROM CaseMaster LIMIT 10', purpose: 'x' },
    { app: fakeApp(sensitive), role: null });
  check('a query returns rows for a cleared caller', (asAdmin.rows || []).length === 1);
  const nobodyText = JSON.stringify(asNobody.rows || []);
  check('an uncleared caller never receives the identifiers',
    !/4321\s?8765\s?9012/.test(nobodyText) && !/9845012345/.test(nobodyText));
  check('what was withheld is reported, not silently dropped',
    !!asNobody.withheld || (asNobody._redactions || []).length > 0);

  // ── Knowledge base and scanned records are filtered too ─────────────────
  const kb = await run('search_knowledge_base', { query: 'arrest procedure' }, {
    role: null,
    ragSearch: async () => 'Accused Ravi Kumar, Aadhaar 4321 8765 9012, was arrested.',
  });
  check('knowledge-base prose passes through the clearance filter',
    kb.found && !/4321\s?8765\s?9012/.test(kb.text));

  const scans = await run('search_scanned_records', { query: 'seizure' }, {
    role: null,
    digitisedSearch: async () => [{ title: 'Seizure memo', docType: 'scan', excerpt: 'Phone 9845012345 seized.' }],
  });
  check('scanned-record excerpts pass through it as well',
    scans.found && !/9845012345/.test(JSON.stringify(scans.records)));

  // ── Failure handling ────────────────────────────────────────────────────
  // The model can recover from a bad result; it cannot recover from the turn
  // ending, so nothing here may throw.
  const boom = await run('query_records', { zcql: 'SELECT CaseMaster.CrimeNo FROM CaseMaster LIMIT 10', purpose: 'x' }, {
    app: { zcql: () => ({ executeZCQLQuery: async () => { throw new Error('data store down'); } }) },
    role: 'admin',
  });
  check('a Data Store outage is returned as a result, not thrown', !!boom.error && /down/.test(boom.error));
  check('a query with no WHERE and no LIMIT is refused, so the store is never scanned whole',
  !!(await run('query_records', { zcql: 'SELECT CaseMaster.CrimeNo FROM CaseMaster', purpose: 'x' },
    { app: fakeApp([]), role: 'admin' })).error);
  check('an unknown tool name is refused politely',
    /Unknown tool/.test((await run('nope', {}, {})).error || ''));
  check('a missing dependency is reported rather than crashing',
    /unavailable/i.test((await run('search_knowledge_base', { query: 'x' }, { role: 'admin' })).error || ''));

  // ── Caps ────────────────────────────────────────────────────────────────
  const many = Array.from({ length: 500 }, (_, i) => ({ CaseMaster: { CaseMasterID: i, CrimeNo: `no-${i}` } }));
  const capped = await run('query_records',
    { zcql: 'SELECT CaseMaster.CrimeNo FROM CaseMaster LIMIT 10', purpose: 'x' },
    { app: fakeApp(many), role: 'admin' });
  check('a large result is capped so one tool call cannot fill the context',
    capped.rows.length <= tools.MAX_ROWS);
  check('the true count is still reported so the model is not misled',
    capped.row_count > capped.rows.length && /matched/.test(capped.note || ''));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
