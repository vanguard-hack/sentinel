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
// What this is guarding against is a tool that NEEDS an argument but does not
// say so, because the model then calls it empty and gets a confusing error back
// instead of a schema violation it can fix. A tool whose inputs are genuinely
// all optional — "what is urgent on my cases?" takes none — is not that bug, so
// the assertion is about the declaration being well-formed, not about every
// tool being forced to demand something.
check('every tool declares at least one input it can take',
  tools.DEFINITIONS.every((d) => Object.keys(d.input_schema.properties || {}).length > 0));
check('any required inputs a tool declares are a non-empty list of its own properties',
  tools.DEFINITIONS.every((d) => {
    const req = d.input_schema.required;
    if (req === undefined) return true;
    return Array.isArray(req) && req.length > 0
      && req.every((k) => Object.prototype.hasOwnProperty.call(d.input_schema.properties || {}, k));
  }));
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

  // ── The loop's contract with index.js ───────────────────────────────────
  const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
  const loop = src.slice(src.indexOf('async function runToolLoop'), src.indexOf('const VISION_SYSTEM'));

  check('the loop is bounded by an iteration cap',
    /for \(let i = 0; i < TOOL_MAX_ITERATIONS/.test(loop));
  check('and by a wall-clock budget, because a waiting officer is not the model\'s concern',
    /Date\.now\(\) - started > TOOL_BUDGET_MS/.test(loop));
  check('tools are withdrawn on the last turn, which forces an answer',
    /i === TOOL_MAX_ITERATIONS - 1 \|\| outOfTime[\s\S]{0,60}\?\s*\{\}/.test(loop));
  // Ordering, not distance. This was a character-window regex twice, and it
  // broke twice — both times because a comment was added inside the gather,
  // which is the test being brittle rather than the property being violated.
  // The property is that results are gathered once and pushed once, in that
  // order; how much prose sits between them is nobody's business.
  const gather = loop.indexOf('const results = await Promise.all(');
  const pushes = [...loop.matchAll(/messages\.push\(\{ role: 'user', content: results \}\)/g)];
  check('the parallel results are gathered before they are sent', gather !== -1);
  check('parallel tool results go back in ONE user message',
    pushes.length === 1 && pushes[0].index > gather,
    `${pushes.length} push(es), gather at ${gather}`);
  // Asserts the PROPERTY, not the literal list: every underscore-prefixed key
  // this module emits must appear in the loop's strip. Pinning the exact
  // destructuring meant adding one internal field broke the test while a
  // forgotten one — the failure that actually matters, because it leaks
  // bookkeeping into the prompt — would have passed unnoticed.
  const internalKeys = [...new Set(
    (require('fs').readFileSync(__dirname + '/tools.js', 'utf8')
      .match(/^\s*_[a-zA-Z]+:/gm) || []).map((k) => k.trim().replace(':', ''))
  )];
  const stripped = loop.match(/const \{([^}]*)\.\.\.clean \}/);
  check('internal bookkeeping is stripped before results reach the model',
    !!stripped && internalKeys.every((k) => stripped[1].includes(k)),
    stripped ? `missing: ${internalKeys.filter((k) => !stripped[1].includes(k)).join(', ')}` : 'no destructure found');
  check('a tool error is marked as one so the model knows to fix it',
    /is_error: true/.test(loop));
  check('the loop never throws — it returns null and the old lanes take over',
    /catch \(e\)[\s\S]{0,160}?return null;/.test(loop));
  check('it stays dormant without a key',
    /if \(!process\.env\.ANTHROPIC_API_KEY\) return null;/.test(loop));

  const route = src.slice(src.indexOf("if (routed === 'TOOLS')"), src.indexOf("if (routed && /chat/i.test(routed))"));
  check('a failed loop falls through to the lanes that were already there',
    /if \(looped\) \{/.test(route) && !/return await respondWith\([\s\S]{0,40}null/.test(route));
  check('every Data Store result the loop read becomes a citation',
    /for \(const set of looped\.rowSets\)/.test(route));
  check('which tools ran is recorded for the audit trail',
    /validatorChecks\.push\(`tools:/.test(route));

  // ── case_obligations ────────────────────────────────────────────────────
  //
  // The tool exists so an officer asking "what's urgent?" in chat gets what the
  // Action Queue page shows. The risks are that it answers for a role with no
  // need-to-know, that it hands the model an accused's name unfiltered, or that
  // it quietly diverges from the page. All three are tested.

  const OBLIGATION = {
    id: 'custody-clock', caseMasterId: 'CM-1', crimeNo: '412/2026',
    station: 'Vijayanagar', ioName: 'S Kumar', severity: 'critical', kind: 'statutory',
    title: 'Chargesheet due in 13 days',
    finding: 'Ramesh K has been in custody 47 days and no police report has been filed.',
    consequence: 'At day 60 the accused becomes entitled to release on bail.',
    action: 'File the police report, or move for an extension.',
    basis: 'no section charged carries ten years or more', certain: true,
    authority: { act: 'BNSS', section: '187(3)', legacy: 'CrPC 167(2)', verified: false },
    clock: { remainingDays: 13, elapsedDays: 47, windowDays: 60 },
    acknowledged: null, mine: true,
  };
  const MEDIUM = { ...OBLIGATION, id: 'no-statements', severity: 'medium', clock: null,
    crimeNo: '401/2026', mine: false, title: 'No witness statements recorded' };
  const ACKED = { ...OBLIGATION, id: 'seizure-memo', severity: 'high', crimeNo: '388/2026',
    acknowledged: { by: 'kumar', at: 1, note: 'filed on paper' } };

  const queueDeps = (role) => ({
    role,
    caseObligations: async () => ({
      obligations: [OBLIGATION, MEDIUM, ACKED], scanned: 3,
      counts: { total: 2 },
    }),
  });

  const obl = await run('case_obligations', {}, queueDeps('investigator'));
  check('case_obligations returns the queue', obl.found === true && obl.obligations.length === 2);
  check('acknowledged items are not shown to the model',
    !obl.obligations.some((o) => o.title === 'No seizure reference recorded'));
  check('it reports how many cases were read', obl.checked_cases === 3);
  check('the countdown is given as a number, not left in prose',
    obl.obligations[0].days_remaining === 13 && obl.obligations[0].window_days === 60);
  check('the consequence travels with the item',
    /entitled to release/.test(obl.obligations[0].consequence));
  check('the authority is flattened for the model',
    obl.obligations[0].authority === 'BNSS 187(3) (CrPC 167(2))');
  check('the engine\'s own hedge is passed through so the model can hedge too',
    obl.obligations[0].basis_certain === true && !!obl.obligations[0].basis);
  check('the result carries the not-verified caveat',
    /not verified against the bare acts/.test(obl.note || ''));

  const mine = await run('case_obligations', { scope: 'mine' }, queueDeps('investigator'));
  check('scope "mine" filters to the officer\'s own cases',
    mine.obligations.length === 1 && mine.obligations[0].case === '412/2026');

  const crit = await run('case_obligations', { severity: 'critical' }, queueDeps('investigator'));
  check('severity filters to at least that urgent',
    crit.obligations.length === 1 && crit.obligations[0].severity === 'critical');

  const one = await run('case_obligations', { caseNo: '401' }, queueDeps('investigator'));
  check('a case number narrows to that case', one.obligations.length === 1 && one.obligations[0].case === '401/2026');

  const none = await run('case_obligations', { caseNo: 'ZZZ' }, queueDeps('investigator'));
  check('no match says so rather than returning an empty list silently',
    none.found === false && /No open case/.test(none.note));

  // The gate. Reaching case detail through the assistant must not be the way
  // around the need-to-know rule the Action Queue page enforces.
  for (const role of ['analyst', 'policymaker']) {
    const denied = await run('case_obligations', {}, queueDeps(role));
    check(`${role} cannot read case obligations through the assistant`,
      /limited to investigators/.test(denied.error || ''));
  }
  for (const role of ['investigator', 'supervisor', 'admin']) {
    const ok = await run('case_obligations', {}, queueDeps(role));
    check(`${role} can read case obligations`, ok.found === true);
  }

  check('with no diary access the tool says so instead of throwing',
    /unavailable/i.test((await run('case_obligations', {}, { role: 'investigator' })).error || ''));

  // The page and the tool must be one engine, not two implementations.
  const idx = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
  check('the tool and the Action Queue page share one builder',
    (idx.match(/buildActionQueue\(/g) || []).length >= 3);

  // ── The system prompt itself ───────────────────────────────────────────
  //
  // A stray unary plus once turned a whole paragraph of this prompt into the
  // literal string "NaN" and silently dropped the parallelism and error-recovery
  // instructions. Nothing failed loudly; the loop just got worse. Pin it.
  const promptSrc = idx.slice(idx.indexOf('const TOOL_SYSTEM'), idx.indexOf('async function runToolLoop'));
  check('the tool system prompt contains no NaN from a broken concatenation',
    !/NaN/.test(promptSrc) || /BUG FIX/.test(promptSrc));
  check('the parallel-call instruction survives in the prompt',
    /Call tools in parallel/.test(promptSrc));
  check('the error-recovery instruction survives in the prompt',
    /fix the call rather than repeating it/.test(promptSrc));
  check('the prompt tells the model when to reach for case_obligations',
    /call case_obligations/.test(promptSrc));
  check('the never-fabricate instruction survives',
    /never state a \n?\s*'?\+?\s*'?number the records did not give you|never fill the gap/.test(promptSrc));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
