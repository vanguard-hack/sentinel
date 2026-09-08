// pdf.js's "disableWorker" only skips spawning a background Worker thread —
// it still dynamically imports the worker module's own code to run inline,
// so GlobalWorkerOptions.workerSrc must point at a real, fetchable file.
//
// Two separate regressions have hit this, both invisible to a plain Jest/
// jsdom run since nothing here can exercise a real browser's dynamic
// import() over real HTTP:
//   1. workerSrc = '' — pdf.js rejects it unconditionally, confirmed live
//      against every PDF, not just scanned ones.
//   2. workerSrc pointing at a vendored .mjs file — fixes (1), but the
//      actual deployed static host (Zoho Catalyst's ZGS) serves .mjs as
//      application/octet-stream, not a JS MIME type, and a browser's
//      dynamic import() strictly refuses to run that as a module (this
//      passed a local `serve`-backed check, which correctly infers .mjs —
//      the discrepancy only showed up against the real deployed host).
//      Vendored as .js instead; confirmed live that the same host serves
//      .js as application/javascript.
// These are config-level guards against either regression coming back,
// not a full behavioural test.
import fs from 'fs';
import path from 'path';

const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const WORKER_PATH = path.join(__dirname, '..', '..', 'public', 'pdf.worker.min.js');

test('attachments.js points workerSrc at the vendored .js file, not .mjs or an empty string', () => {
  const src = readSrc('utils/attachments.js');
  expect(src).toMatch(/workerSrc\s*=\s*`\$\{process\.env\.PUBLIC_URL[^}]*\}\/pdf\.worker\.min\.js`/);
  expect(src).not.toMatch(/workerSrc\s*=\s*'';/);
  expect(src).not.toMatch(/pdf\.worker\.min\.mjs/);
});

test('digitise.js points workerSrc at the vendored .js file, not .mjs or an empty string', () => {
  const src = readSrc('utils/digitise.js');
  expect(src).toMatch(/workerSrc\s*=\s*`\$\{process\.env\.PUBLIC_URL[^}]*\}\/pdf\.worker\.min\.js`/);
  expect(src).not.toMatch(/workerSrc\s*=\s*'';/);
  expect(src).not.toMatch(/pdf\.worker\.min\.mjs/);
});

test('the worker file both of them point at exists in public/ with a .js extension', () => {
  expect(fs.existsSync(WORKER_PATH)).toBe(true);
  // No .mjs sibling left behind — one true copy, not two that can drift.
  expect(fs.existsSync(path.join(__dirname, '..', '..', 'public', 'pdf.worker.min.mjs'))).toBe(false);
  // A truncated/placeholder file would break every PDF the same way an
  // empty workerSrc did — the real file is well over 1MB.
  expect(fs.statSync(WORKER_PATH).size).toBeGreaterThan(500_000);
});

test('the vendored worker file matches the pdfjs-dist version pinned in package.json', () => {
  const pkg = JSON.parse(readSrc('../package.json'));
  const pinned = pkg.dependencies['pdfjs-dist'].replace(/^\D*/, '');
  const worker = fs.readFileSync(WORKER_PATH, 'utf8');
  expect(worker).toContain(pinned);
});
