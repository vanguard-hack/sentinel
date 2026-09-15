// Minimal ZIP reader for the Office formats.
//
// DOCX, XLSX and PPTX are all ZIP archives of XML. Rather than pull in a zip
// library (and ship it to every officer who never uploads one), this reads the
// central directory itself and inflates entries with the browser's built-in
// DecompressionStream. Two methods cover real Office files: stored (0) and
// deflate (8).

const dv = (buf) => new DataView(buf);

// The central directory lives at the end, behind a variable-length comment, so
// it is found by scanning backwards for its signature.
function findCentralDirectory(buf) {
  const view = dv(buf);
  const max = Math.min(buf.byteLength, 66_000); // 64K comment ceiling + header
  for (let i = buf.byteLength - 22; i >= buf.byteLength - max && i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      return { count: view.getUint16(i + 10, true), offset: view.getUint32(i + 16, true) };
    }
  }
  return null;
}

async function inflateRaw(bytes) {
  // deflate-raw is the ZIP storage format (no zlib header). Written and read
  // through the stream directly rather than via Blob/Response — those add two
  // more globals to depend on for no gain, and the reader loop is explicit
  // about assembling the chunks.
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// Returns a Map of path → Uint8Array for the entries `wanted` selects. Reading
// only the parts we need keeps a 40MB deck from being fully inflated when all
// we want is its slide text.
export async function readZip(file, wanted = () => true) {
  const buf = await file.arrayBuffer();
  const end = findCentralDirectory(buf);
  if (!end) throw new Error('not a readable Office file');
  const view = dv(buf);
  const out = new Map();

  let p = end.offset;
  for (let i = 0; i < end.count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (!wanted(name)) continue;

    // The local header repeats the name and extra field with its own lengths,
    // which are NOT always the same as the central directory's — the data
    // offset has to be computed from the local header itself.
    const lnameLen = view.getUint16(localOffset + 26, true);
    const lextraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lnameLen + lextraLen;
    const raw = new Uint8Array(buf, start, compressedSize);
    try {
      out.set(name, method === 0 ? raw : await inflateRaw(raw));
    } catch {
      // A single unreadable part shouldn't lose the rest of the document.
    }
  }
  return out;
}

export const decode = (bytes) => (bytes ? new TextDecoder().decode(bytes) : '');
