import {
  contextKind, unusableReason, contextLabel, contextDetail, attachState, contextSummary,
} from '../utils/attachments';

// An attachment in the composer has to say, before the officer hits send,
// whether the assistant will actually see it. These are the rules behind that.

const file = (name, type = '', size = 1000) => ({ name, type, size });

test('an image goes to the vision pre-parser', () => {
  expect(contextKind(file('scan.jpg', 'image/jpeg'))).toBe('image');
});

test('documents Records can read are read for the assistant too', () => {
  ['seizure.xlsx', 'statement.docx', 'briefing.pptx', 'notes.txt', 'list.csv', 'report.pdf']
    .forEach((n) => expect(contextKind(file(n))).toBe('document'));
});

test('audio is transcribed into the composer, not attached', () => {
  expect(contextKind(file('interview.m4a', 'audio/mp4'))).toBe('audio');
});

test('what cannot be read is named as such, with a reason worth reading', () => {
  expect(contextKind(file('clip.mp4', 'video/mp4'))).toBe('unusable');
  expect(unusableReason(file('clip.mp4', 'video/mp4'))).toMatch(/Records/);
  expect(unusableReason(file('old.doc'))).toMatch(/re-save/i);
});

test('a file too large to read in the browser is refused up front', () => {
  const huge = file('huge.xlsx', '', 40 * 1024 * 1024);
  expect(contextKind(huge)).toBe('unusable');
  expect(unusableReason(huge)).toMatch(/too large/i);
});

// ── What the chip says ─────────────────────────────────────────────────────

test('a document being read says so, then says it was read', () => {
  const reading = { kind: 'document', reading: true };
  expect(contextLabel(reading)).toBe('reading…');
  expect(attachState(reading)).toBe('reading');

  const done = { kind: 'document', reading: false, context: { ok: true, text: 'x'.repeat(1200) } };
  expect(contextLabel(done)).toBe('read as context');
  expect(attachState(done)).toBe('ready');
  expect(contextDetail(done)).toMatch(/1,200 characters sent with your question/);
});

test('a document that could not be read says so rather than looking fine', () => {
  const a = {
    kind: 'document', reading: false,
    context: { ok: false, reason: 'scanned PDF with no embedded text — file it in Records to OCR it' },
  };
  expect(contextLabel(a)).toBe('not readable');
  expect(attachState(a)).toBe('skipped');
  expect(contextDetail(a)).toMatch(/Not sent as context — scanned PDF/);
});

test('an image whose vision pass came back empty is not shown as read', () => {
  expect(attachState({ kind: 'image', parsed: true, digest: null })).toBe('skipped');
  expect(contextLabel({ kind: 'image', parsed: true, digest: null })).toBe('not readable');
  expect(attachState({ kind: 'image', parsed: true, digest: { ok: true } })).toBe('ready');
});

test('a file type nothing can read is explicit about being carried by name only', () => {
  const a = { kind: 'unusable', reason: 'video — file it in Records to transcribe it' };
  expect(contextLabel(a)).toBe('not sent as context');
  expect(contextDetail(a)).toMatch(/Not sent as context — video/);
});

// ── What the tray says ─────────────────────────────────────────────────────

const ready = { kind: 'document', context: { ok: true, text: 'x' } };
const skipped = { kind: 'unusable' };

test('the tray counts what is going and what is not', () => {
  expect(contextSummary([ready, ready]).text)
    .toBe('2 files will be sent as context with your question.');
  expect(contextSummary([ready, skipped]))
    .toEqual({ tone: 'partial', text: "1 file will be sent as context with your question; 1 can't be read." });
});

test('the tray does not claim context when nothing can be read', () => {
  const s = contextSummary([skipped]);
  expect(s.tone).toBe('skipped');
  expect(s.text).toMatch(/won't be sent as context/);
});

test('a read still in flight is reported as such, not as ready', () => {
  expect(contextSummary([{ kind: 'document', reading: true }, ready]))
    .toEqual({ tone: 'reading', text: 'Reading 1 file…' });
});

test('an empty tray says nothing at all', () => {
  expect(contextSummary([])).toBeNull();
});
