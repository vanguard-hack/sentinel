/**
 * @jest-environment node
 *
 * A zip dropped on Records is unpacked in the browser and its files are filed
 * one by one. Runs under Node for the same reason office.test.js does: jsdom
 * cannot feed DecompressionStream. The fixtures are genuine ZIP output from
 * Python's zipfile, not archives shaped to match this parser.
 */
import fs from 'fs';
import path from 'path';
import { File as NodeFile } from 'buffer';
import { filesFromZip, detectKind } from '../utils/extract';

if (typeof global.DecompressionStream === 'undefined') {
  // eslint-disable-next-line global-require
  global.DecompressionStream = require('stream/web').DecompressionStream;
}
if (typeof global.File === 'undefined') global.File = NodeFile;

const load = (name) => {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', name));
  return { name, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

test('a .zip is recognised as an archive, but a .docx (also a zip inside) is not', () => {
  expect(detectKind({ name: 'evidence.zip', type: 'application/zip' })).toBe('zip');
  expect(detectKind({ name: 'seizure.docx', type: '' })).toBe('word');
});

test('unpacks the documents and drops folders, __MACOSX and hidden files', async () => {
  const files = await filesFromZip(load('bundle.zip'));
  expect(files.map((f) => f.name).sort()).toEqual(['inner.zip', 'seizure.docx', 'statement.txt']);
  const statement = files.find((f) => f.name === 'statement.txt');
  expect(await statement.text()).toContain('red scooter');
  // Each unpacked file is classified exactly like a dropped one.
  expect(detectKind(files.find((f) => f.name === 'seizure.docx'))).toBe('word');
  expect(detectKind(files.find((f) => f.name === 'inner.zip'))).toBe('zip');
});

test('refuses an archive with too many files', async () => {
  await expect(filesFromZip(load('many.zip'))).rejects.toThrow(/more than 100 files/);
});

test('refuses a zip bomb from its declared size, before inflating it', async () => {
  // 200 KB on disk, 201 MB once unpacked.
  await expect(filesFromZip(load('bomb.zip'))).rejects.toThrow(/over 200 MB once unpacked/);
});

test('an entry that lies about its size is dropped once it inflates past the claim', async () => {
  // big.txt declares 10 bytes but holds 50 MB of zeros. Trusting the
  // declaration would let a crafted archive slip under the 200 MB cap and
  // still exhaust the tab; inflation stops at the declared size instead.
  const files = await filesFromZip(load('liar.zip'));
  expect(files.map((f) => f.name)).toEqual(['ok.txt']);
});

test('a file that is not really a zip gets a plain message', async () => {
  const fake = { name: 'x.zip', arrayBuffer: async () => new ArrayBuffer(64) };
  await expect(filesFromZip(fake)).rejects.toThrow('not a readable zip file');
});
