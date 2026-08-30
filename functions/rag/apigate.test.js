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
check(`all ${routeCount} routes are dispatched after the gate`,
  src.slice(0, gateAt).indexOf("path.endsWith('") === -1);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
