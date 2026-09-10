// Slash commands: parsing, role gates, and the query each command expands
// to. Run: node functions/rag/slash.test.js

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// The slash-command helpers live inside index.js's module scope, so they are
// re-declared here from the same source to keep this test dependency-free —
// same technique router.test.js already uses for the routing helpers.
const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');

const grabFn = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('missing function ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
};

// SLASH_ROLES/SLASH_HELP are multi-line object/array literals, not the
// single-line consts router.test.js's regex approach handles — this tracks
// bracket depth from the opening `{` or `[`, skipping over the CONTENTS of
// single-quoted strings (so a literal '[' inside e.g. '/fir [FIR number]'
// is never miscounted as a structural bracket) and over `//` line comments
// (so an apostrophe in ordinary prose — "tool's own", say — is never
// mistaken for the start of a string).
const grabConst = (name) => {
  const i = src.indexOf(`const ${name} = `);
  if (i < 0) throw new Error('missing const ' + name);
  const openAt = i + `const ${name} = `.length;
  const open = src[openAt];
  const close = open === '{' ? '}' : ']';
  let d = 0, k = openAt, inString = false;
  for (; k < src.length; k++) {
    const ch = src[k];
    if (inString) {
      if (ch === '\\') { k++; continue; } // skip an escaped character
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === '/' && src[k + 1] === '/') { // skip to end of line
      const nl = src.indexOf('\n', k);
      k = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === "'") { inString = true; continue; }
    if (ch === open) d++;
    else if (ch === close && --d === 0) { k++; break; }
  }
  return src.slice(i, k + 1); // include the trailing ;
};

// eslint-disable-next-line no-new-func
const { SLASH_ROLES, SLASH_SENSITIVE, SLASH_HELP, parseSlash, slashToQuery } = new Function(
  grabConst('SLASH_ROLES') + '\n' +
  grabConst('SLASH_SENSITIVE') + '\n' +
  grabConst('SLASH_HELP') + '\n' +
  grabFn('parseSlash') + '\n' +
  grabFn('slashToQuery') +
  '\nreturn { SLASH_ROLES, SLASH_SENSITIVE, SLASH_HELP, parseSlash, slashToQuery };'
)();

// ── The three tool-backed commands ──────────────────────────────────────
for (const name of ['osint', 'sanctions', 'crypto']) {
  check(`/${name} is a recognised command`, name in SLASH_ROLES);
  check(`/${name} carries the same role gate as its tool`,
    Array.isArray(SLASH_ROLES[name])
    && ['admin', 'supervisor', 'investigator', 'analyst'].every((r) => SLASH_ROLES[name].includes(r))
    && !SLASH_ROLES[name].includes('policymaker'));
  check(`/${name} is audit-logged as sensitive`, SLASH_SENSITIVE.has(name));
  check(`/${name} is documented in /help`, SLASH_HELP.some(([cmd]) => cmd.startsWith(`/${name} `)));
}

check('parseSlash recognises /osint with an argument',
  JSON.stringify(parseSlash('/osint 185.220.101.45')) === JSON.stringify({ name: 'osint', arg: '185.220.101.45' }));
check('parseSlash recognises /sanctions with a multi-word argument',
  JSON.stringify(parseSlash('/sanctions John Doe')) === JSON.stringify({ name: 'sanctions', arg: 'John Doe' }));
check('parseSlash recognises /crypto with an argument',
  JSON.stringify(parseSlash('/crypto bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'))
    === JSON.stringify({ name: 'crypto', arg: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' }));

// ── The expanded query each command produces ────────────────────────────
//
// Precise enough to route to TOOLS and the right tool reliably, and close
// enough to that tool's own description that the disambiguation work
// already done for it carries over.
const osintQ = slashToQuery('osint', '185.220.101.45');
check('/osint expands to a question naming the value and asking about registration/abuse data',
  /185\.220\.101\.45/.test(osintQ) && /registration/i.test(osintQ) && /abuse/i.test(osintQ));

const sanctionsQ = slashToQuery('sanctions', 'John Doe');
check('/sanctions expands to a question naming the value and asking about sanctions/watchlist status',
  /John Doe/.test(sanctionsQ) && /sanctions|watchlist/i.test(sanctionsQ));

const cryptoQ = slashToQuery('crypto', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh');
check('/crypto expands to a question naming the address and asking about balance/activity',
  /bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh/.test(cryptoQ)
  && /balance/i.test(cryptoQ) && /transaction/i.test(cryptoQ));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
