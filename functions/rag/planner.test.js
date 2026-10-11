// Planner + answer judge: the contract the rest of the pipeline relies on.
// The model is stubbed — what is under test is what we do with its reply.
// Run: node functions/rag/planner.test.js

const planner = require('./planner');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};
const reply = (o) => async () => (typeof o === 'string' ? o : JSON.stringify(o));

(async () => {
  // ── parsePlan ─────────────────────────────────────────────────────────
  const full = planner.parsePlan(JSON.stringify({
    standalone_question: 'How many cases involve the Ravi Kumar gang?',
    route: 'zcql', confidence: 0.9, needs_memory: true, needs_records: false, recent_firs: false,
    entities: [{ type: 'gang', value: 'Ravi Kumar gang' }, { type: 'alien', value: 'x' }, { value: '' }],
  }), 'how many cases does that gang have');
  check('a full plan is parsed', full && full.route === 'ZCQL' && full.confidence === 0.9);
  check('  the rewrite is kept', full.standalone_question === 'How many cases involve the Ravi Kumar gang?');
  check('  an unknown entity type becomes "other", an empty one is dropped',
    full.entities.length === 2 && full.entities[1].type === 'other');

  check('prose around the JSON is tolerated',
    planner.parsePlan('Sure! {"route":"RAG","confidence":0.7}', 'q')?.route === 'RAG');
  check('a route the pipeline does not have fails the plan',
    planner.parsePlan('{"route":"SQL","confidence":0.9}', 'q') === null);
  check('an unparseable reply fails the plan', planner.parsePlan('¯\\_(ツ)_/¯', 'q') === null);
  check('no reply fails the plan', planner.parsePlan(null, 'q') === null);
  check('confidence is clamped to 0..1',
    planner.parsePlan('{"route":"RAG","confidence":7}', 'q').confidence === 1);
  check('a missing confidence is treated as just above the floor, not certain',
    planner.parsePlan('{"route":"RAG"}', 'q').confidence === 0.6);
  check('flags are strict — the string "true" is not true',
    planner.parsePlan('{"route":"RAG","needs_memory":"true"}', 'q').needs_memory === false);
  check('an empty rewrite falls back to the message',
    planner.parsePlan('{"route":"RAG","standalone_question":"  "}', 'orig').standalone_question === 'orig');

  // ── plan() ────────────────────────────────────────────────────────────
  const invented = await planner.plan({
    query: 'how many thefts',
    context: '',
    llm: reply({ route: 'ZCQL', confidence: 0.9, standalone_question: 'How many thefts in 2024 in Mysuru?' }),
  });
  check('with no context the message is used verbatim — the model cannot add a year',
    invented.standalone_question === 'how many thefts');

  const resolved = await planner.plan({
    query: 'what about that gang',
    context: 'Recent conversation:\nuser: who leads the Ravi Kumar gang?',
    llm: reply({ route: 'ZCQL', confidence: 0.8, standalone_question: 'What about the Ravi Kumar gang?' }),
  });
  check('with context the rewrite is used', resolved.standalone_question === 'What about the Ravi Kumar gang?');

  check('a model that throws gives no plan (caller falls back)',
    (await planner.plan({ query: 'q', llm: async () => { throw new Error('down'); } })) === null);
  check('a model that returns nothing gives no plan',
    (await planner.plan({ query: 'q', llm: async () => null })) === null);

  let sent = null;
  await planner.plan({
    query: 'does this match anything on file?', context: '', hasAttachment: true,
    llm: async (m) => { sent = m; return '{"route":"ZCQL"}'; },
  });
  check('the planner is told a file was attached', /attached a file/.test(sent[1].content));
  check('  but never shown the file itself', !/UNTRUSTED/.test(sent[1].content));

  // ── judgeAnswer ───────────────────────────────────────────────────────
  const judge = (out) => planner.judgeAnswer({ question: 'q', answer: 'a', llm: async () => out });
  check('NON_ANSWER is a non-answer', (await judge('NON_ANSWER')) === true);
  check('ANSWER is an answer', (await judge('ANSWER')) === false);
  check('NON_ANSWER is not misread as ANSWER', (await judge('non-answer.')) === true);
  check('an unclear verdict is no verdict, so the caller decides', (await judge('maybe')) === null);
  check('a failed judge is no verdict',
    (await planner.judgeAnswer({ question: 'q', answer: 'a', llm: async () => { throw new Error('x'); } })) === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
