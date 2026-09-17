import { buildFlatText, mapRedactionsToTokens } from '../utils/documentRedact';

// buildFlatText/mapRedactionsToTokens are the pure half of document redaction
// (no pdf.js/Tesseract/canvas involved) — the offset bookkeeping that maps a
// backend-reported character span back to the on-page token(s) it came from.
// Extraction itself (pdf.js text layers, Tesseract OCR, canvas rendering) is
// browser-API-dependent and verified live, not here.

const page = (tokens) => ({ tokens: tokens.map((text) => ({ text, x: 0, y: 0, width: 1, height: 1 })) });

test('flattens tokens across pages into one space-joined string with per-token spans', () => {
  const { flatText, spans } = buildFlatText([
    page(['Ravi', 'Kumar', 'met']),
    page(['Suresh']),
  ]);
  expect(flatText).toBe('Ravi Kumar met Suresh');
  expect(spans).toEqual([
    { start: 0, end: 4, pageIndex: 0, tokenIndex: 0 },
    { start: 5, end: 10, pageIndex: 0, tokenIndex: 1 },
    { start: 11, end: 14, pageIndex: 0, tokenIndex: 2 },
    { start: 15, end: 21, pageIndex: 1, tokenIndex: 0 },
  ]);
});

test('a redaction spanning two tokens (a multi-word entity) covers both', () => {
  const { flatText, spans } = buildFlatText([page(['Ravi', 'Kumar', 'called'])]);
  expect(flatText).toBe('Ravi Kumar called');
  // "Ravi Kumar" is flatText[0:10] — a single PERSON redaction over that range.
  const covered = mapRedactionsToTokens([{ type: 'PERSON', start: 0, end: 10 }], spans);
  expect(covered).toEqual([
    { pageIndex: 0, tokenIndex: 0, type: 'PERSON' },
    { pageIndex: 0, tokenIndex: 1, type: 'PERSON' },
  ]);
});

test('a redaction on one page does not touch tokens on another', () => {
  const { spans } = buildFlatText([page(['Ravi']), page(['Suresh'])]);
  // "Suresh" starts at index 5 in the flat text.
  const covered = mapRedactionsToTokens([{ type: 'PERSON', start: 5, end: 11 }], spans);
  expect(covered).toEqual([{ pageIndex: 1, tokenIndex: 0, type: 'PERSON' }]);
});

test('a token untouched by any redaction is not covered', () => {
  const { spans } = buildFlatText([page(['Ravi', 'met', 'Suresh'])]);
  const covered = mapRedactionsToTokens([{ type: 'PERSON', start: 0, end: 4 }], spans);
  expect(covered).toEqual([{ pageIndex: 0, tokenIndex: 0, type: 'PERSON' }]);
});

test('the same token is not duplicated when two redactions overlap it', () => {
  const { spans } = buildFlatText([page(['Ravi'])]);
  const covered = mapRedactionsToTokens(
    [{ type: 'PERSON', start: 0, end: 2 }, { type: 'PERSON', start: 1, end: 4 }],
    spans
  );
  expect(covered).toEqual([{ pageIndex: 0, tokenIndex: 0, type: 'PERSON' }]);
});

test('no redactions covers no tokens', () => {
  const { spans } = buildFlatText([page(['Ravi', 'Kumar'])]);
  expect(mapRedactionsToTokens([], spans)).toEqual([]);
  expect(mapRedactionsToTokens(undefined, spans)).toEqual([]);
});
