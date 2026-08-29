// Records Digitisation data layer.
//
// Scans are sent as hex (the same transport the investigation OCR endpoint
// uses — Catalyst Advanced I/O reads a text body reliably, whereas raw binary
// gets mangled). Large photos are downscaled in the browser first: phone
// cameras produce 5-10 MB frames, the endpoint caps at 8 MB, and OCR gains
// nothing from resolution beyond about 2200px.
const MAX_EDGE = 2200;
const JPEG_QUALITY = 0.86;

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const listRecords = () => post('/server/rag/digitise/list').then((d) => d.records || []);
export const getRecord = (id) => post('/server/rag/digitise/get', { id }).then((d) => d.record);
export const updateRecord = (patch) => post('/server/rag/digitise/update', patch).then((d) => d.record);
export const deleteRecord = (id) => post('/server/rag/digitise/delete', { id });
export const searchRecords = (query, limit) =>
  post('/server/rag/digitise/search', { query, limit }).then((d) => d.hits || []);

export const newBatchId = () =>
  'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Draw the image to a canvas, capped on the longest edge, and re-encode as
// JPEG. Also normalises HEIC/PNG/WebP into something Zia OCR accepts.
export function normaliseImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not read this image'))),
        'image/jpeg',
        JPEG_QUALITY,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Unsupported or corrupt image file'));
    };
    img.src = url;
  });
}

const toHex = (buf) => {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
};

// Render every page of a PDF to a JPEG blob. pdf.js is heavy (~350 kB), so it
// is imported only when a PDF actually turns up. Scanned files arrive as PDFs
// at least as often as images, and Zia OCR only accepts images.
export async function pdfToImages(file, onProgress) {
  const pdfjs = await import('pdfjs-dist');
  // Run the parser on the main thread: the worker is a separate asset that
  // CRA does not emit, and a scanned page renders fast enough without it.
  pdfjs.GlobalWorkerOptions.workerSrc = '';
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
  const out = [];
  const count = Math.min(doc.numPages, 40);
  for (let i = 1; i <= count; i++) {
    // eslint-disable-next-line no-await-in-loop
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, MAX_EDGE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale: Math.max(1, scale) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // eslint-disable-next-line no-await-in-loop
    await page.render({ canvasContext: ctx, viewport }).promise;
    // eslint-disable-next-line no-await-in-loop
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    if (blob) {
      const name = file.name.replace(/\.pdf$/i, '');
      out.push(new File([blob], `${name} — p${i}.jpg`, { type: 'image/jpeg' }));
    }
    if (onProgress) onProgress(i, count);
  }
  return out;
}

export const isPdf = (file) => /pdf/i.test(file.type) || /\.pdf$/i.test(file.name);

export async function uploadScan(file, { batchId = '', caseMasterId = '', appendTo = '' } = {}) {
  const blob = await normaliseImage(file);
  const hex = toHex(await blob.arrayBuffer());
  const qs = new URLSearchParams({
    filename: file.name || 'scan.jpg',
    mime: 'image/jpeg',
    batchId,
    caseMasterId,
    appendTo,
  });
  const res = await fetch(`/server/rag/digitise/upload?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: hex,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.record;
}

// Stored scans are fetched through an authenticated endpoint and turned into a
// data URL — they are never publicly reachable.
export async function fetchScanUrl(key) {
  const d = await post('/server/rag/digitise/file', { key });
  return `data:image/jpeg;base64,${d.data}`;
}

export function recordsToCsv(records) {
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const head = ['Title', 'Document type', 'Crime No.', 'File', 'Uploaded by', 'Uploaded at', 'Summary', 'Extracted text'];
  const lines = [head.map(esc).join(',')];
  records.forEach((r) => {
    lines.push([
      r.title, r.docType, r.crimeNo || '', r.filename, r.uploadedByName || '',
      r.createdAt ? new Date(r.createdAt).toISOString() : '',
      r.summary || '', (r.text || '').slice(0, 20000),
    ].map(esc).join(','));
  });
  return lines.join('\n');
}
