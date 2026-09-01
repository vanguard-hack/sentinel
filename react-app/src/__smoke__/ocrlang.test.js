// OCR language selection.
//
// In its own file because records.test.js mocks utils/digitise wholesale to
// keep the gallery tests off the network — importing the real helper there
// gets the mock, and a test that silently exercises a stub is worse than no
// test at all.
// ── OCR language ──────────────────────────────────────────────────────────
//
// The server computed an OCR language from the request and then passed the
// literal 'eng' to Zia, and the client never sent one at all — so every scan
// was read as English. Silent, and worse than a failure: OCR "succeeded" and
// returned text, just not the text on the page, and the structuring pass
// downstream made fields out of it.
import { ocrLangFor } from '../utils/digitise';

test('the officer\'s language selects the OCR model', () => {
  expect(ocrLangFor('kn')).toBe('kan');
  expect(ocrLangFor('hi')).toBe('hin');
  expect(ocrLangFor('en')).toBe('eng');
});

test('a regional variant still resolves', () => {
  expect(ocrLangFor('kn-IN')).toBe('kan');
  expect(ocrLangFor('en-GB')).toBe('eng');
});

test('an unknown or missing language falls back to English rather than failing', () => {
  expect(ocrLangFor('fr')).toBe('eng');
  expect(ocrLangFor('')).toBe('eng');
  expect(ocrLangFor(undefined)).toBe('eng');
  expect(ocrLangFor(null)).toBe('eng');
});

// ── Every transcription call site must pass a language ────────────────────
//
// The default parameter on transcribeAudio is 'en', which makes an omitted
// language silent: a Kannada recording comes back as plausible Latin nonsense
// and nothing errors. Two call sites had already been fixed one at a time when
// a third was found still defaulting, so this asserts the property across the
// source rather than the three.
import fs from 'fs';
import path from 'path';

test('no caller of transcribeAudio omits the language', () => {
  const root = path.join(__dirname, '..');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__smoke__' ? [] : walk(full);
    return /\.(js|jsx)$/.test(e.name) ? [full] : [];
  });

  // Walk to the MATCHING close paren rather than the first one. The first
  // attempt at this stopped at the `new File(...)` inside the argument list and
  // reported two false positives — a checker that cries wolf about correct code
  // is one somebody deletes.
  const argsOf = (src, from) => {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return src.slice(from + 1, i);
      }
    }
    return null;
  };

  // Top-level commas only: the ones inside new File(...) or an object literal
  // separate ITS arguments, not transcribeAudio's.
  const topLevelArgs = (args) => {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < args.length; i++) {
      const c = args[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ',' && depth === 0) { out.push(args.slice(start, i)); start = i + 1; }
    }
    out.push(args.slice(start));
    return out.map((a) => a.trim()).filter(Boolean);
  };

  const offenders = [];
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, 'utf8');
    if (/export async function transcribeAudio/.test(src)) continue;
    let at = src.indexOf('transcribeAudio(');
    while (at !== -1) {
      const args = argsOf(src, at + 'transcribeAudio'.length);
      if (args !== null && topLevelArgs(args).length < 2) {
        offenders.push(`${path.relative(root, file)}: ${args.replace(/\s+/g, ' ').slice(0, 70)}`);
      }
      at = src.indexOf('transcribeAudio(', at + 1);
    }
  }
  expect(offenders).toEqual([]);
});
