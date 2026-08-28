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

export async function uploadScan(file, { batchId = '', caseMasterId = '' } = {}) {
  const blob = await normaliseImage(file);
  const hex = toHex(await blob.arrayBuffer());
  const qs = new URLSearchParams({
    filename: file.name || 'scan.jpg',
    mime: 'image/jpeg',
    batchId,
    caseMasterId,
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
