// Stratus key confinement: routes that accept an object key from the client.
// Run: node functions/rag/keys.test.js

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');

// Lift confineKey out of the source and run the real thing, rather than
// asserting on how it reads. A guard tested by regex is a guard that passes
// while doing nothing.
const fnSrc = src.slice(src.indexOf('function confineKey('));
const body = fnSrc.slice(0, fnSrc.indexOf('\n}\n') + 3);
// eslint-disable-next-line no-new-func
const confineKey = new Function(`${body}; return confineKey;`)();

const MEDIA = 'investigation/media/';
const DIG = 'digitise/files/';

// ── The legitimate case still works ────────────────────────────────────────
// A guard that breaks playback is not a guard, it is an outage.
check('a key this function issued is accepted',
  confineKey(`${MEDIA}4412/rec-8f3a.m4a`, MEDIA) === `${MEDIA}4412/rec-8f3a.m4a`);
check('a digitise source key is accepted',
  confineKey(`${DIG}abc123.pdf`, DIG) === `${DIG}abc123.pdf`);
check('the accepted key is returned unchanged, not rewritten',
  confineKey(`${MEDIA}a/b/c.jpg`, MEDIA) === `${MEDIA}a/b/c.jpg`);

// ── Traversal ──────────────────────────────────────────────────────────────
// The attack the old startsWith check let through: the prefix is present, so
// it passed, and everything after it walked back out of the prefix. Whether
// that reached the role map depended on how Stratus resolves "..", which is
// not a question this codebase should be answering.
check('traversal out of the media prefix is refused',
  confineKey(`${MEDIA}../../access/roles.json`, MEDIA) === null);
check('traversal out of the digitise prefix is refused',
  confineKey(`${DIG}../../../access/roles.json`, DIG) === null);
check('a single .. anywhere in the key is refused',
  confineKey(`${MEDIA}case/../other/x.mp4`, MEDIA) === null);
check('an encoded-looking dotdot is still just dotdot to us',
  confineKey(`${MEDIA}..%2f..%2froles.json`, MEDIA) === null);

// ── Prefix confusion ───────────────────────────────────────────────────────
check('a key outside the prefix is refused',
  confineKey('access/roles.json', MEDIA) === null);
check('a sibling prefix that merely starts the same is refused',
  confineKey('investigation/media-private/x.mp4', MEDIA) === null);
check('the media prefix is not accepted for a digitise route',
  confineKey(`${MEDIA}x.mp4`, DIG) === null);

// ── Shape ──────────────────────────────────────────────────────────────────
check('an absolute path is refused',
  confineKey(`/${MEDIA}x.mp4`, MEDIA) === null);
check('a backslash is refused',
  confineKey(`${MEDIA}a\\..\\roles.json`, MEDIA) === null);
check('a NUL byte is refused',
  confineKey(`${MEDIA}x.mp4\u0000.png`, MEDIA) === null);
check('a newline is refused',
  confineKey(`${MEDIA}x.mp4\n`, MEDIA) === null);
check('a DEL character is refused',
  confineKey(`${MEDIA}x\u007f.mp4`, MEDIA) === null);
check('an absurdly long key is refused',
  confineKey(MEDIA + 'a'.repeat(600), MEDIA) === null);

// ── Non-strings ────────────────────────────────────────────────────────────
// The body is parsed JSON, so key can arrive as any type the attacker likes.
check('an empty key is refused', confineKey('', MEDIA) === null);
check('a missing key is refused', confineKey(undefined, MEDIA) === null);
check('a null key is refused', confineKey(null, MEDIA) === null);
check('a number is refused', confineKey(42, MEDIA) === null);
// String(['a','b']) is 'a,b' — an array cannot smuggle traversal past the
// checks, because they run on the coerced string.
check('an array carrying traversal is refused',
  confineKey([`${MEDIA}../../roles.json`], MEDIA) === null);

// ── The call sites actually use it ─────────────────────────────────────────
// A helper nobody calls protects nothing.
check('no client-supplied key is still checked with a bare startsWith',
  !/const key = String\(body\.key \|\| ''\);/.test(src));
check('all three client-key routes go through confineKey',
  (src.match(/confineKey\(body\.key/g) || []).length === 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
