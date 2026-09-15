/* The PDF builder is pure and Tiptap-free, so it can be verified directly:
   rich narrative HTML, legacy plain text, and floating text boxes. */
import { buildReportHtml } from '../utils/reportStudio';
import { reportTypeById } from '../data/reportTemplates';

const fir = reportTypeById('fir');

test('rich narrative HTML is rendered, not escaped', () => {
  const html = buildReportHtml(fir, {
    title: 'T',
    pages: [{ uid: 'p1', sheetId: 'fir-contents', values: { firContents: '<p>Hello <strong>world</strong></p>' } }],
  });
  expect(html).toContain('<strong>world</strong>');
  expect(html).not.toContain('&lt;strong&gt;');
});

test('legacy plain-text narrative keeps its line breaks', () => {
  const html = buildReportHtml(fir, {
    title: 'T',
    pages: [{ uid: 'p1', sheetId: 'fir-contents', values: { firContents: 'line one\nline two' } }],
  });
  expect(html).toContain('line one<br/>line two');
});

test('script tags in narrative HTML are stripped', () => {
  const html = buildReportHtml(fir, {
    title: 'T',
    pages: [{ uid: 'p1', sheetId: 'fir-contents', values: { firContents: '<p>ok</p><script>alert(1)</script>' } }],
  });
  expect(html).not.toContain('alert(1)');
});

test('document page emits its editor HTML including a positioned text box', () => {
  const html = buildReportHtml(fir, {
    title: 'T',
    pages: [{
      uid: 'p1',
      sheetId: 'blank',
      html: '<p>flow</p><div data-text-box="" style="position:absolute;left:40px;top:50px">boxed</div>',
    }],
  });
  expect(html).toContain('data-text-box');
  expect(html).toContain('left:40px');
  expect(html).toContain('class="docbody"');
});
