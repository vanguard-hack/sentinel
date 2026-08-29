import { detectKind, isPageKind, KIND_LABEL } from '../utils/extract';

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
