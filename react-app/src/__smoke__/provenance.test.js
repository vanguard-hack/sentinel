import { provenanceOf, isMedia, isPaper, sizeOf, PROVENANCE } from '../utils/provenance';

const rec = (sourceKind, extra = {}) => ({ sourceKind, ...extra });

describe('record provenance', () => {
  it('never calls a transcript "read by OCR"', () => {
    for (const kind of ['audio', 'video']) {
      expect(provenanceOf(rec(kind)).note).not.toMatch(/OCR/i);
      expect(provenanceOf(rec(kind)).note).toMatch(/speech recognition/i);
    }
  });

  it('warns about OCR only where OCR was actually used', () => {
    expect(provenanceOf(rec('scan')).note).toMatch(/OCR/i);
    expect(provenanceOf(rec('sheet')).note).not.toMatch(/OCR/i);
    expect(provenanceOf(rec('word')).note).not.toMatch(/OCR/i);
  });

  it('tells the officer that directly-read text is exact, not a best guess', () => {
    for (const kind of ['sheet', 'word', 'slides', 'text']) {
      expect(provenanceOf(rec(kind)).note).toMatch(/exact/i);
    }
  });

  it('every kind states where corrections go, so the promise is not kind-specific', () => {
    for (const p of Object.values(PROVENANCE)) {
      expect(p.note).toMatch(/assistant will search/i);
      expect(p.empty).toBeTruthy();
      expect(p.label).toBeTruthy();
    }
  });

  it('falls back to the scan wording for an unknown or legacy record', () => {
    // Records filed before sourceKind existed carry no kind at all.
    expect(provenanceOf({}).note).toBe(PROVENANCE.scan.note);
    expect(provenanceOf(rec('something-new')).note).toBe(PROVENANCE.scan.note);
    expect(provenanceOf(null).note).toBe(PROVENANCE.scan.note);
  });

  it('routes each kind to the right pane', () => {
    expect(isMedia('audio')).toBe(true);
    expect(isMedia('video')).toBe(true);
    expect(isMedia('sheet')).toBe(false);
    expect(isPaper('scan')).toBe(true);
    expect(isPaper('pdf')).toBe(true);
    expect(isPaper('audio')).toBe(false);
  });

  it('treats a record with no kind as paper — that is what the old ones are', () => {
    expect(isPaper(undefined)).toBe(true);
    expect(isPaper('')).toBe(true);
  });
});

describe('record size display', () => {
  it('shows bytes rather than rounding a short transcript to "0 KB"', () => {
    expect(sizeOf({ bytes: 300 })).toBe('300 B');
  });

  it('prefers the original file size over the extracted text size', () => {
    expect(sizeOf({ bytes: 300, sourceBytes: 2 * 1024 * 1024 })).toBe('2.0 MB');
    expect(sizeOf({ bytes: 300 }, { bytes: 5120 })).toBe('5 KB');
  });

  it('scales the unit to the magnitude', () => {
    expect(sizeOf({ bytes: 1023 })).toBe('1023 B');
    expect(sizeOf({ bytes: 4096 })).toBe('4 KB');
    expect(sizeOf({ bytes: 3 * 1024 * 1024 })).toBe('3.0 MB');
  });

  it('shows nothing at all rather than a meaningless zero', () => {
    expect(sizeOf({ bytes: 0 })).toBe('');
    expect(sizeOf({})).toBe('');
    expect(sizeOf(null)).toBe('');
  });
});
