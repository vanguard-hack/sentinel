import {
  contextKind, unusableReason, contextLabel, contextDetail, attachState,
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

// An ATTACHED recording is evidence, not dictation.
//
// It used to be transcribed straight into the composer, which made it the
// officer's own message: it reached the server as the question itself, took the
// lenient input path meant for officers, and was never fenced as untrusted
// content — so a seized voice note saying "ignore all previous instructions"
// was read as though the officer had typed it, while the same sentence in a PDF
// was correctly fenced. It is now read as context, exactly like a document.
test('an attached recording is read as context, not treated as the officer speaking', () => {
  expect(contextKind(file('interview.m4a', 'audio/mp4'))).toBe('audio');
  expect(contextKind(file('voicenote.ogg', 'audio/ogg'))).toBe('audio');
});

test('and the chip says the recording was transcribed', () => {
  const a = { kind: 'audio', context: { ok: true, text: 'the accused said…' } };
  expect(contextLabel(a)).toBe('transcribed');
});

test('a recording still being transcribed says so', () => {
  expect(contextLabel({ kind: 'audio', reading: true })).toBe('reading…');
  expect(contextDetail({ kind: 'audio', reading: true })).toMatch(/transcrib/i);
});

test('a recording with no speech in it is not silently sent as empty context', () => {
  const a = { kind: 'audio', context: { ok: false, reason: 'no speech could be recognised' } };
  expect(contextLabel(a)).toBe('not readable');
  expect(contextDetail(a)).toMatch(/no speech/);
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
  expect(contextLabel(done)).toBe('');
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
