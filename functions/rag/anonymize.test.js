// PII detection/anonymization core. Run: node functions/rag/anonymize.test.js
const anonymize = require('./anonymize');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// Locates a substring by value instead of hand-counted indices, so a typo in
// the fixture text can't silently desync the expected span.
const span = (text, value, from = 0) => {
  const start = text.indexOf(value, from);
  if (start < 0) throw new Error(`fixture bug: "${value}" not found in "${text}"`);
  return { start, end: start + value.length, text: value };
};

// ── Regex recognizers ───────────────────────────────────────────────────────
{
  const text = 'FIR 42/2026 was registered on 04/03/2026 after a call from 9876543210.';
  const hits = anonymize.regexEntities(text);
  const firHit = hits.find((h) => h.type === 'FIR_NUMBER');
  check('FIR number is recognised', !!firHit && firHit.text === '42/2026');
  const dateHit = hits.find((h) => h.type === 'DATE');
  check('DD/MM/YYYY date is recognised', !!dateHit && dateHit.text === '04/03/2026');
  const phoneHit = hits.find((h) => h.type === 'PHONE');
  check('10-digit Indian mobile number is recognised', !!phoneHit && phoneHit.text === '9876543210');
  check('every regex hit carries the matched span exactly',
    hits.every((h) => text.slice(h.start, h.end) === h.text));
}

// ── Overlap resolution ──────────────────────────────────────────────────────
{
  const text = 'Ravi Kumar was seen near Chennai.';
  const shortHit = { type: 'PERSON', ...span(text, 'Ravi Kuma'), score: 0.6 };
  const longHit = { type: 'PERSON', ...span(text, 'Ravi Kumar'), score: 0.9 };
  const locHit = { type: 'LOCATION', ...span(text, 'Chennai'), score: 0.8 };
  const kept = anonymize.resolveOverlaps([shortHit, longHit, locHit]);
  check('the higher-scoring entity wins an overlap',
    kept.length === 2 && kept[0].text === 'Ravi Kumar');
  check('non-overlapping entities all survive', kept.some((e) => e.text === 'Chennai'));
  check('kept entities are sorted by start position',
    kept.every((e, i) => i === 0 || kept[i - 1].start <= e.start));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
