// Cross-site request forgery: the Origin gate on cookie-authenticated POSTs.
// Run: node functions/rag/csrf.test.js

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');

// Run the real function rather than asserting on how it reads.
const frag = src.slice(src.indexOf('const APP_ORIGINS ='), src.indexOf('// ── IP blocklist'));
// eslint-disable-next-line no-new-func
const build = (env) => new Function('process', `${frag}; return originAllowed;`)({ env });
const originAllowed = build({});

const APP = 'https://sentinel-60073599957.development.catalystserverless.in';

// ── The console still works ────────────────────────────────────────────────
check('the app\'s own origin is allowed', originAllowed(APP) === true);
check('a trailing slash does not break the match', originAllowed(`${APP}/`) === true);
check('case is not significant in a hostname', originAllowed(APP.toUpperCase()) === true);
check('local development is allowed', originAllowed('http://localhost:3000') === true);
check('local development by ip is allowed', originAllowed('http://127.0.0.1:3000') === true);

// ── Absent Origin is allowed, and that is the design ───────────────────────
// A CSRF attack runs in a browser, and a browser cannot suppress Origin. curl,
// CI and server-to-server callers omit it and are not the threat — they still
// have to get past the session gate immediately after.
check('a request with no Origin reaches the session gate', originAllowed(undefined) === true);
check('an empty Origin reaches the session gate', originAllowed('') === true);

// ── The attack ─────────────────────────────────────────────────────────────
check('a hostile site is refused', originAllowed('https://evil.example') === false);
check('an opaque (sandboxed iframe) origin is refused', originAllowed('null') === false);

// ── Hostname matching, not string matching ─────────────────────────────────
// The reason this is parsed with URL rather than checked with includes().
check('a lookalike that merely contains the domain is refused',
  originAllowed('https://evil-catalystserverless.in.attacker.com') === false);
check('a domain suffixed onto an attacker host is refused',
  originAllowed('https://catalystserverless.in.evil.com') === false);
check('a fragment cannot smuggle the domain in',
  originAllowed('https://attacker.com/#.catalystserverless.in') === false);
check('a userinfo segment cannot smuggle the domain in',
  originAllowed('https://sentinel.catalystserverless.in@evil.example') === false);
check('unparseable garbage is refused', originAllowed('not-a-url') === false);

// ── Transport ──────────────────────────────────────────────────────────────
check('plain http on a real host is refused', originAllowed(`http://sentinel.catalystserverless.in`) === false);

// ── The override ───────────────────────────────────────────────────────────
const pinned = build({ ALLOWED_ORIGINS: 'https://one.example, https://two.example' });
check('ALLOWED_ORIGINS pins the list exactly', pinned('https://one.example') === true);
check('a second pinned origin is allowed', pinned('https://two.example') === true);
check('pinning excludes the built-in defaults', pinned(APP) === false);
check('pinning still lets an absent Origin through', pinned(undefined) === true);

// ── It is actually wired in, ahead of the session lookup ───────────────────
// A gate nobody calls is decoration.
const callAt = src.indexOf('if (!originAllowed(req.headers && req.headers.origin))');
const gateAt = src.indexOf('const session = await requireSession(req, res);');
const firstRoute = src.indexOf("if (path.endsWith('/transcribe'))");
check('the origin check runs in the router', callAt > 0);
check('a forged request is refused before the session is looked up',
  callAt > 0 && gateAt > 0 && callAt < gateAt);
check('the origin check runs before any route is dispatched',
  callAt > 0 && firstRoute > 0 && callAt < firstRoute);
check('a refused cross-origin request gets 403, not a silent pass',
  /Cross-origin requests are not allowed/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
