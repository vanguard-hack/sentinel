// Officer memory. Run: node functions/rag/memory.test.js
const m = require('./memory');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

// ── Recall intent ──────────────────────────────────────────────────────────
// Reaching for past conversations on every turn would spend a retrieval call
// answering questions that have nothing to do with what was said before.
check('a question about the past asks for recall',
  m.wantsRecall('what did we discuss about FIR 4029 last week?'));
check('"you told me" asks for recall',
  m.wantsRecall('you told me the Hubballi case was closed'));
check('a plain data question does not',
  !m.wantsRecall('how many FIRs were filed in Belagavi in March'));
check('a place name containing "before" is not a recall question',
  !m.wantsRecall('list thefts in Beforepur'));

// ── Assembled context ──────────────────────────────────────────────────────
const buffer = {
  turns: [
    { role: 'user', text: 'who is the IO on FIR 4029?' },
    { role: 'assistant', text: 'PSI Kulkarni.' },
    { role: 'tool', text: 'internal scratch' },
  ],
  resumed: true,
};
const facts = [
  { memory_key: 'pref#reports', kind: 'preference', value: 'prefers tables over prose' },
  { memory_key: 'session#abc', kind: 'session', value: '{"session_id":"abc"}' },
  { memory_key: 'summary#abc', kind: 'summary', value: 'discussed FIR 4029' },
];

const asm = m.assemble({ buffer, facts, recalled: null });
check('only spoken turns become history', asm.history.length === 2);
check('history keeps role and content shape',
  asm.history[0].role === 'user' && typeof asm.history[0].content === 'string');
check('a stated preference reaches the prompt', /prefers tables/.test(asm.longTerm));
check('session pointers are bookkeeping, not context',
  !/session#|"session_id"/.test(asm.longTerm));
check('summaries are recall material, not standing context',
  !/discussed FIR 4029/.test(asm.longTerm));

const withRecall = m.assemble({ buffer, facts, recalled: { text: '- discussed FIR 4029' } });
check('recall is included when the question asked for it',
  /discussed FIR 4029/.test(withRecall.longTerm));

check('no memory yields no context block',
  m.assemble({ buffer: null, facts: [], recalled: null }).longTerm === '');

// ── Consolidation parsing ──────────────────────────────────────────────────
// The model is asked for JSON; it routinely wraps it in prose or a fence.
const parsed = m.parseConsolidation(
  'Here you go:\n```json\n{"summary":"Discussed FIR 4029.","facts":[' +
  '{"memory_key":"case#4029","value":"working FIR 4029","ttl_days":null},' +
  '{"memory_key":"nonsense","value":"junk"}]}\n```\nHope that helps.'
);
check('a fenced JSON reply still parses', parsed && parsed.summary === 'Discussed FIR 4029.');
check('a fact with an unrecognised key prefix is dropped',
  parsed && parsed.facts.length === 1 && parsed.facts[0].memory_key === 'case#4029');
check('a reply with no JSON at all is refused', m.parseConsolidation('I could not summarise that.') === null);
check('a reply missing the summary is refused', m.parseConsolidation('{"facts":[]}') === null);

// ── Session pointers ───────────────────────────────────────────────────────
// Turns are partitioned by session, so without these an officer's own sessions
// are unenumerable — which would make "delete my memory" impossible to carry out.
const sessions = m.sessionsOf(facts.concat([{ memory_key: 'session#bad', value: 'not json' }]));
check('session pointers are recovered from the facts table',
  sessions.length === 1 && sessions[0].session_id === 'abc');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
