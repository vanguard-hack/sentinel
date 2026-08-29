import { detectKind, isPageKind, KIND_LABEL, filesFromClipboard } from '../utils/extract';

const f = (name, type = '') => ({ name, type, size: 100 });

describe('records file-type detection', () => {
  it('routes photographed and scanned paper to the page pipeline', () => {
    expect(isPageKind(detectKind(f('page.jpg', 'image/jpeg')))).toBe(true);
    expect(isPageKind(detectKind(f('scan.webp', 'image/webp')))).toBe(true);
    expect(isPageKind(detectKind(f('file.pdf', 'application/pdf')))).toBe(true);
  });

  it('recognises the Office formats officers actually produce', () => {
    expect(detectKind(f('seizure list.xlsx'))).toBe('sheet');
    expect(detectKind(f('statement.docx'))).toBe('word');
    expect(detectKind(f('briefing.pptx'))).toBe('slides');
    expect(detectKind(f('export.csv'))).toBe('sheet');
  });

  it('recognises recordings, whether audio or video', () => {
    expect(detectKind(f('interview.mp3', 'audio/mpeg'))).toBe('audio');
    expect(detectKind(f('statement.m4a'))).toBe('audio');
    expect(detectKind(f('cctv.mp4', 'video/mp4'))).toBe('video');
    expect(detectKind(f('bodycam.mov'))).toBe('video');
  });

  it('recognises plain text and subtitle files', () => {
    expect(detectKind(f('notes.txt', 'text/plain'))).toBe('text');
    expect(detectKind(f('log.log'))).toBe('text');
    expect(detectKind(f('transcript.srt'))).toBe('text');
  });

  it('reads legacy .xls rather than refusing it — SheetJS handles it', () => {
    expect(detectKind(f('old.xls'))).toBe('sheet');
  });

  it('separates legacy Office from genuinely unknown files, so the advice differs', () => {
    expect(detectKind(f('old.doc'))).toBe('legacy');
    expect(detectKind(f('deck.ppt'))).toBe('legacy');
    expect(detectKind(f('archive.zip'))).toBe('unsupported');
    expect(detectKind(f('binary.exe'))).toBe('unsupported');
  });

  it('does not send text-bearing files through the scanning pipeline', () => {
    for (const name of ['a.xlsx', 'b.docx', 'c.pptx', 'd.txt', 'e.mp3', 'f.mp4']) {
      expect(isPageKind(detectKind(f(name)))).toBe(false);
    }
  });

  it('names every kind it can file, so no card shows a blank label', () => {
    for (const kind of ['sheet', 'word', 'slides', 'text', 'audio', 'video', 'image', 'pdf']) {
      expect(KIND_LABEL[kind]).toBeTruthy();
    }
  });

  it('trusts the extension over a missing or generic MIME type', () => {
    // Browsers routinely report '' or application/octet-stream for Office
    // files, so extension has to be authoritative.
    expect(detectKind(f('report.docx', ''))).toBe('word');
    expect(detectKind(f('data.xlsx', 'application/octet-stream'))).toBe('sheet');
  });
});

describe('pasting files into Records', () => {
  const AT = new Date('2026-08-29T14:30:05Z');
  const item = (blob) => ({ kind: 'file', getAsFile: () => blob });

  it('takes a file copied from Finder or Explorer with its real name', () => {
    const copied = new File(['x'], 'seizure list.xlsx');
    const out = filesFromClipboard({ files: [copied], items: [] });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('seizure list.xlsx');
  });

  it('gives a pasted screenshot a timestamped name, not "image.png"', () => {
    const shot = new File([''], 'image.png', { type: 'image/png' });
    const out = filesFromClipboard({ files: [], items: [item(shot)] }, AT);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('pasted-2026-08-29-14-30-05.png');
  });

  it('keeps two screenshots pasted at once distinct', () => {
    const shot = () => new File([''], 'image.png', { type: 'image/png' });
    const out = filesFromClipboard({ files: [], items: [item(shot()), item(shot())] }, AT);
    expect(out.map((f) => f.name)).toEqual([
      'pasted-2026-08-29-14-30-05.png',
      'pasted-2026-08-29-14-30-05-2.png',
    ]);
  });

  it('normalises the jpeg MIME subtype to a .jpg extension', () => {
    const shot = new File([''], 'image.png', { type: 'image/jpeg' });
    expect(filesFromClipboard({ files: [], items: [item(shot)] }, AT)[0].name)
      .toBe('pasted-2026-08-29-14-30-05.jpg');
  });

  it('respects a real name on an item rather than renaming it', () => {
    const named = new File([''], 'fir-page-2.png', { type: 'image/png' });
    expect(filesFromClipboard({ files: [], items: [item(named)] }, AT)[0].name)
      .toBe('fir-page-2.png');
  });

  it('ignores pasted text, so the search box keeps working', () => {
    expect(filesFromClipboard({ files: [], items: [{ kind: 'string' }] })).toEqual([]);
    expect(filesFromClipboard({ files: [], items: [] })).toEqual([]);
  });

  it('survives a clipboard with nothing on it', () => {
    expect(filesFromClipboard(null)).toEqual([]);
    expect(filesFromClipboard({})).toEqual([]);
  });

  it('does not double-count when a file appears in both files and items', () => {
    const copied = new File(['x'], 'report.docx');
    const out = filesFromClipboard({ files: [copied], items: [item(copied)] });
    expect(out).toHaveLength(1);
  });
});
