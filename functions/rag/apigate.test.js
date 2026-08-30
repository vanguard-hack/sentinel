// API gate: authentication, identity source, rate limiting.
// Run: node functions/rag/apigate.test.js

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');

// ── Every route sits behind the gate ──────────────────────────────────────
// The gate is in the router, so a new endpoint is protected by default. This
// asserts the ordering that makes that true.
const gateAt = src.indexOf('const session = await requireSession(req, res);');
const firstRoute = src.indexOf("if (path.endsWith('/transcribe'))");
check('the session gate runs before the first route is dispatched',
  gateAt > 0 && firstRoute > 0 && gateAt < firstRoute);
check('a request with no session is refused, not served',
  /if \(!session\) return undefined;/.test(src));

// Count the routes so the gate cannot silently stop covering new ones.
const routeCount = (src.match(/path\.endsWith\('/g) || []).length;
check(`all ${routeCount - 1} data routes are dispatched after the gate`,
  (src.slice(0, gateAt).match(/path\.endsWith\('/g) || []).length === 1);

// ── Health check: the one route ahead of the gate ─────────────────────────
// It has to leak nothing. Booleans about whether config is present, never a
// value, and no identity, record or user data.
const healthBlock = src.slice(src.indexOf("if (path.endsWith('/health'))"), src.indexOf('// Cheapest check first'));
// Assert on what the route actually emits, not on how the source reads: the
// payload is rebuilt here with recognisable fake secrets, and none of them may
// survive into the JSON. A bare `process.env.SOMETHING` in the response object
// would publish the key itself.
const FAKES = {
  GROQ_API_KEY: 'gsk_LEAKCANARY_groq',
  ANTHROPIC_API_KEY: 'sk-ant-LEAKCANARY',
  RAG_REFRESH_TOKEN: '1000.LEAKCANARY.rag',
};
const payloadStart = healthBlock.indexOf('{', healthBlock.indexOf('json(res, 200,'));
const payloadSrc = healthBlock.slice(payloadStart, healthBlock.indexOf('});', payloadStart) + 1);
// eslint-disable-next-line no-new-func
const emitted = new Function('process', 'PROVIDER_ORDER', `return (${payloadSrc});`)(
  { env: FAKES }, ['groq', 'claude']
);
const asJson = JSON.stringify(emitted);
check('the health route reports which providers are configured',
  emitted.providers.groq === true && emitted.providers.claude === true && emitted.rag === true);
check('no secret value survives into the health payload',
  !/LEAKCANARY/.test(asJson));
check('the health payload carries no free-text field a value could hide in',
  Object.values(emitted.providers).every((v) => typeof v === 'boolean' || Array.isArray(v)));
check('the health route returns no identity or record data',
  !/requestUser|email|badge|datastore|stratus/i.test(healthBlock));
check('health is the only route ahead of the session gate',
  src.indexOf("path.endsWith('/health')") < gateAt
  && src.slice(0, gateAt).match(/path\.endsWith\('/g).length === 1);

// ── Identity comes from the session, never the payload ────────────────────
// The regression this guards: /conversations/* and /profile/* selected whose
// data to read and write from an email in the request, so anyone who knew a
// colleague's address could read or delete that officer's history.
const bodyOf = (name) => {
  const i = src.indexOf(`async function ${name}(`);
  if (i < 0) throw new Error('missing ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  return '';
};
['handleConversations', 'handleProfile', 'handleProfilePhoto'].forEach((h) => {
  const b = bodyOf(h);
  const assigns = /const email = String\((?:body|param)/.test(b);
  check(`${h} does not take its identity from the request`, !assigns);
  check(`${h} resolves the caller from the session`, /await requestUser\(/.test(b));
});

// Assigning someone else's role is the one place another user may be named,
// and it has to stay behind the admin check.
const access = bodyOf('handleAccess');
check('role assignment stays behind the admin check',
  access.indexOf("isAdminUser(caller)") < access.indexOf('// save — assign a role'));
check('/access/me reads the role of the session user, not a named one',
  /if \(action === 'me'\)[\s\S]{0,320}?await requestUser\(app\)/.test(access));

// ── Rate limiting ─────────────────────────────────────────────────────────
// eslint-disable-next-line no-new-func
const mk = new Function(`
  const RATE_WINDOW_MS = 60000;
  const rateBuckets = new Map();
  ${src.slice(src.indexOf('function rateLimited(key, max)'), src.indexOf('// Routes that cost money'))}
  return rateLimited;`);
const rateLimited = mk();
let blocked = 0;
for (let i = 0; i < 25; i++) if (rateLimited('officer@ksp.gov.in:metered', 20)) blocked++;
check('a metered route stops the caller after its budget', blocked === 5);
check('a different officer has their own budget',
  rateLimited('other@ksp.gov.in:metered', 20) === 0);
check('a refusal says how long to wait', rateLimited('officer@ksp.gov.in:metered', 20) > 0);

const METERED = new RegExp(src.match(/const METERED_ROUTES = (\/.*\/);/)[1].slice(1, -1));
['/transcribe', '/vision/parse', '/reportdocs/ai', '/investigation/ocr', '/digitise/ingest']
  .forEach((p) => check(`${p} is treated as metered`, METERED.test(p)));
['/conversations/list', '/access/me', '/investigation/list']
  .forEach((p) => check(`${p} is not metered`, !METERED.test(p)));

// ── IP blocklist ──────────────────────────────────────────────────────────
// A denylist, not an allowlist: officers connect from stations across the
// state, so an allowlist would lock out legitimate users while stopping nobody
// who already holds a session.
// eslint-disable-next-line no-new-func
const ipBlocked = new Function(`
  ${src.slice(src.indexOf('const blockedIps = () =>'), src.indexOf('// ── Rate limiting'))}
  return ipBlocked;`)();

const withBlocked = (list, fn) => {
  const prev = process.env.BLOCKED_IPS;
  process.env.BLOCKED_IPS = list;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.BLOCKED_IPS; else process.env.BLOCKED_IPS = prev;
  }
};

check('nothing is blocked when the list is empty',
  withBlocked('', () => !ipBlocked('203.0.113.7')));
check('an exact address is blocked',
  withBlocked('203.0.113.7', () => ipBlocked('203.0.113.7')));
check('a neighbouring address is not',
  withBlocked('203.0.113.7', () => !ipBlocked('203.0.113.70')));
check('a trailing dot blocks the whole range',
  withBlocked('198.51.100.', () => ipBlocked('198.51.100.42')));
check('a prefix does not leak into a similar range',
  withBlocked('198.51.100.', () => !ipBlocked('198.51.1007')));
check('an IPv6 prefix is matched case-insensitively',
  withBlocked('2001:DB8:', () => ipBlocked('2001:db8::1')));
check('an absent address is never blocked',
  withBlocked('203.0.113.7', () => !ipBlocked('')));
check('the blocklist is read per request, so a change needs no redeploy',
  /process\.env\.BLOCKED_IPS/.test(src.slice(src.indexOf('const blockedIps'), src.indexOf('function ipBlocked'))));

// ── Provider chain ────────────────────────────────────────────────────────
// One outage must degrade an answer, not remove it.
check('every LLM call goes through the chain, not a single provider',
  (src.match(/\bcallLLM\(/g) || []).length > 15
  && (src.match(/\bcallGroq\(/g) || []).length === 1);
check('the chain tries the next provider when one returns nothing',
  /for \(const name of PROVIDER_ORDER\)[\s\S]{0,220}?if \(out !== null/.test(src));
check('Claude stays dormant without a key',
  /async function callClaude[\s\S]{0,200}?if \(!process\.env\.ANTHROPIC_API_KEY\) return null;/.test(src));
check('the system prompt is lifted out of the message array for Anthropic',
  /if \(m\.role === 'system'\) \{ system\.push/.test(src));
check('a conversation handed to Anthropic never opens on an assistant turn',
  /while \(turns\.length && turns\[0\]\.role === 'assistant'\) turns\.shift\(\);/.test(src));
check('thinking tokens are budgeted for, so a short call is not truncated',
  /max_tokens: Math\.max\(1024, maxTokens \+ 768\)/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
