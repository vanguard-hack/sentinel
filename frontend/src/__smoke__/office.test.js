/**
 * @jest-environment node
 *
 * Runs under Node rather than jsdom: jsdom's Blob has no working .stream(),
 * so DecompressionStream cannot be fed from it. The parser itself is
 * environment-agnostic — real browsers supply both.
 *
 * Parses real Office files (built by Python's zipfile, i.e. genuine ZIP
 * output — not a fixture shaped to match our own parser) through the same
 * readZip path the browser uses.
 */
import fs from 'fs';
import path from 'path';
import { readZip, decode } from '../utils/unzip';

// jest's node environment does not inject the web-streams globals.
if (typeof global.DecompressionStream === 'undefined') {
  // eslint-disable-next-line global-require
  global.DecompressionStream = require('stream/web').DecompressionStream;
}

// Genuine ZIP output (built by Python's zipfile), committed so this always
// runs — a parser verified only against fixtures its own writer produced
// proves nothing.
const DIR = path.join(__dirname, 'fixtures');
const load = (name) => {
  const buf = fs.readFileSync(path.join(DIR, name));
  return { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};



describe('zip reader against real Office files', () => {
  it('inflates a deflated .docx entry and finds the document body', async () => {
    const parts = await readZip(load('test.docx'), (n) => n === 'word/document.xml');
    const xml = decode(parts.get('word/document.xml'));
    expect(xml).toContain('SEIZURE MEMO');
    expect(xml).toContain('KA 05 MJ 2841');
  });

  it('reads every slide of a .pptx, not just the first', async () => {
    const parts = await readZip(load('test.pptx'), (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    expect(parts.size).toBe(2);
    const all = [...parts.values()].map(decode).join(' ');
    expect(all).toContain('Crime Trends Q1');
    expect(all).toContain('Theft up 12 percent');
  });

  it('reads only the entries asked for, so a large deck is not fully inflated', async () => {
    const parts = await readZip(load('test.pptx'), (n) => n === 'ppt/slides/slide2.xml');
    expect([...parts.keys()]).toEqual(['ppt/slides/slide2.xml']);
  });
});
