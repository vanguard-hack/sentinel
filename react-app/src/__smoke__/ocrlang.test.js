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
