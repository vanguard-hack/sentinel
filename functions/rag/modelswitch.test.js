// The assistant's model switcher: MODEL_CHOICES / orderForModel in index.js.
// Run: node functions/rag/modelswitch.test.js
//
// GLM is deliberately excluded from the automatic fallback chain (it
// measurably mishandles structured ZCQL generation — see the benchmark run
// this session) and must only ever be reached when an officer explicitly
// picks it. That property lives in orderForModel's own logic, so this
// extracts and evaluates the real function rather than asserting on how the
// source reads — a guard tested by regex is a guard that passes while doing
// nothing.

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
const start = src.indexOf("const MODEL_CHOICES = ['groq', 'glm', 'claude']");
const end = src.indexOf('\n}\n', src.indexOf('function orderForModel')) + 2;
const fragmentSrc = src.slice(start, end);

check('the fragment was found (index.js has not moved/renamed these)',
  start > 0 && fragmentSrc.includes('function orderForModel'));

// eslint-disable-next-line no-new-func
// PROVIDERS and PROVIDER_ORDER are orderForModel's only free variables.
// Every PROVIDERS key present so nothing is filtered by the MODEL_CHOICES/
// SAFE_FALLBACK truthiness check, matching how PROVIDERS is actually built
// (its 3 provider functions always exist regardless of which API keys are
// configured). PROVIDER_ORDER stands in for the deployment default.
const DEFAULT_ORDER = ['groq', 'claude'];
const { MODEL_CHOICES, SAFE_FALLBACK, orderForModel } = new Function(
  'PROVIDERS', 'PROVIDER_ORDER',
  `${fragmentSrc}\nreturn { MODEL_CHOICES, SAFE_FALLBACK, orderForModel };`
)({ groq: () => {}, glm: () => {}, claude: () => {} }, DEFAULT_ORDER);

check('all three providers are offered', JSON.stringify(MODEL_CHOICES) === JSON.stringify(['groq', 'glm', 'claude']));

check('GLM is not in the safe-fallback set', !SAFE_FALLBACK.includes('glm'));
check('groq and claude are the safe fallbacks', SAFE_FALLBACK.includes('groq') && SAFE_FALLBACK.includes('claude'));

check('no request (a non-UI caller) falls through to the deployment default',
  orderForModel(null) === DEFAULT_ORDER);
check('an unrecognised model string is ignored, not trusted',
  orderForModel('gpt-4') === DEFAULT_ORDER);
check('an empty string is ignored',
  orderForModel('') === DEFAULT_ORDER);

check('picking groq puts groq first, with claude as the only fallback (no glm)',
  JSON.stringify(orderForModel('groq')) === JSON.stringify(['groq', 'claude']));

check('picking claude puts claude first, with groq as the only fallback (no glm)',
  JSON.stringify(orderForModel('claude')) === JSON.stringify(['claude', 'groq']));

check('picking glm puts glm first, but STILL falls back to groq and claude if glm fails',
  JSON.stringify(orderForModel('glm')) === JSON.stringify(['glm', 'groq', 'claude']));

check('the returned order never contains a duplicate of the chosen provider',
  new Set(orderForModel('claude')).size === orderForModel('claude').length);

console.log(fail ? `\n${fail} FAILED, ${pass} passed.` : `\nAll ${pass} model-switch checks passed.`);
process.exit(fail ? 1 : 0);
