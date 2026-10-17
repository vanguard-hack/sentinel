// Assistant entry: the question is type-checked and size-bounded before any
// lane (and any metered model) sees it. Run: node functions/rag/querycap.test.js

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// Evaluate the real readQuery from index.js rather than asserting on its text.
const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
const grab = (start, end) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error('missing ' + start);
  return src.slice(i, src.indexOf(end, i) + end.length);
};
const capLine = grab('const MAX_QUERY_CHARS = ', ';');
const fnSrc = grab('function readQuery(', '\n}');
const { MAX_QUERY_CHARS, readQuery } = new Function(`${capLine}\n${fnSrc}\nreturn { MAX_QUERY_CHARS, readQuery };`)();

check('normal question passes, trimmed', readQuery({ query: '  cases in Mysuru  ' }).query === 'cases in Mysuru');
check('missing query is 400', readQuery({}).status === 400);
check('blank query is 400', readQuery({ query: '   ' }).status === 400);
check('non-string query is 400, not a crash', readQuery({ query: { $ne: 1 } }).status === 400);
check('array query is 400', readQuery({ query: ['a'] }).status === 400);
check('exactly at the cap passes', readQuery({ query: 'a'.repeat(MAX_QUERY_CHARS) }).query?.length === MAX_QUERY_CHARS);
const over = readQuery({ query: 'a'.repeat(MAX_QUERY_CHARS + 1) });
check('over the cap is 413', over.status === 413 && /too long/.test(over.error));
check('the entry point actually uses readQuery', /const q = readQuery\(body\);/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
