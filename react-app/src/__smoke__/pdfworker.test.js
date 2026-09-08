// pdf.js's "disableWorker" only skips spawning a background Worker thread —
// it still dynamically imports the worker module's own code to run inline,
// so GlobalWorkerOptions.workerSrc must point at a real, fetchable file.
// Both attachments.js and digitise.js used to set it to '', which pdf.js
// rejects unconditionally (confirmed live: every PDF failed, not just
// scanned ones) before ever touching the file being read. Nothing in this
// repo's Jest/jsdom setup can exercise the real dynamic import (no real
// browser, no real HTTP server), so these are the config-level guards
// against the regression coming back rather than a full behavioural test.
import fs from 'fs';
import path from 'path';

const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('attachments.js points workerSrc at a real vendored file, not an empty string', () => {
  const src = readSrc('utils/attachments.js');
  expect(src).toMatch(/workerSrc\s*=\s*`\$\{process\.env\.PUBLIC_URL[^}]*\}\/pdf\.worker\.min\.mjs`/);
  expect(src).not.toMatch(/workerSrc\s*=\s*'';/);
});

test('digitise.js points workerSrc at a real vendored file, not an empty string', () => {
  const src = readSrc('utils/digitise.js');
  expect(src).toMatch(/workerSrc\s*=\s*`\$\{process\.env\.PUBLIC_URL[^}]*\}\/pdf\.worker\.min\.mjs`/);
  expect(src).not.toMatch(/workerSrc\s*=\s*'';/);
});

test('the worker file both of them point at actually exists in public/', () => {
  const p = path.join(__dirname, '..', '..', 'public', 'pdf.worker.min.mjs');
  expect(fs.existsSync(p)).toBe(true);
  // A truncated/placeholder file would break every PDF the same way an
  // empty workerSrc did — the real file is well over 1MB.
  expect(fs.statSync(p).size).toBeGreaterThan(500_000);
});

test('the vendored worker file matches the pdfjs-dist version pinned in package.json', () => {
  const pkg = JSON.parse(readSrc('../package.json'));
  const pinned = pkg.dependencies['pdfjs-dist'].replace(/^\D*/, '');
  const worker = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'pdf.worker.min.mjs'), 'utf8'
  );
  expect(worker).toContain(pinned);
});
