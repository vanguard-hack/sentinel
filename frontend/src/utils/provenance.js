// How a record was captured decides what its detail page may claim about it.
//
// This is not cosmetic. Calling a transcript "read by OCR" is simply false,
// and an officer who trusts that caption is being misled about how reliable
// the words are — a misheard name in speech recognition fails differently
// from a smudged character in a scan, and each warrants different caution.

export const PROVENANCE = {
  audio: {
    label: 'Recording',
    note: 'Transcribed from the recording — speech recognition mishears words, so check the audio before relying on a quote. Corrections you save here are what the assistant will search.',
    empty: 'No speech could be recognised in this recording.',
  },
  video: {
    label: 'Recording',
    note: 'Transcribed from the recording — speech recognition mishears words, so check the audio before relying on a quote. Corrections you save here are what the assistant will search.',
    empty: 'No speech could be recognised in this recording.',
  },
  sheet: {
    label: 'Spreadsheet',
    note: 'Read directly from the spreadsheet, so the text is exact. Corrections you save here are what the assistant will search.',
    empty: 'This spreadsheet had no readable cells.',
  },
  word: {
    label: 'Document',
    note: 'Read directly from the document, so the text is exact. Corrections you save here are what the assistant will search.',
    empty: 'This document had no readable text.',
  },
  slides: {
    label: 'Presentation',
    note: 'Read directly from the presentation, so the text is exact. Corrections you save here are what the assistant will search.',
    empty: 'This presentation had no readable text.',
  },
  text: {
    label: 'Text file',
    note: 'Read directly from the file, so the text is exact. Corrections you save here are what the assistant will search.',
    empty: 'This file was empty.',
  },
  scan: {
    label: 'Scan',
    note: 'Read by OCR — verify against the original before relying on it. Corrections you save here are what the assistant will search.',
    empty: 'No text was extracted from this scan.',
  },
};
export const provenanceOf = (rec) => PROVENANCE[rec?.sourceKind] || PROVENANCE.scan;

// Prefer the original file's size; fall back to the text's. Formatted with a
// unit that suits the magnitude — a 300-byte transcript rounded to "0 KB",
// which reads as a broken record rather than a short one.
export function sizeOf(rec, media) {
  const n = media?.bytes || rec?.sourceBytes || rec?.bytes || 0;
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const isMedia = (kind) => kind === 'audio' || kind === 'video';
export const isPaper = (kind) => !kind || kind === 'scan' || kind === 'image' || kind === 'pdf';
