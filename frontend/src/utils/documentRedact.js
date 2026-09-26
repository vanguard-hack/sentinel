// Document redaction: extract positioned text from a PDF or image, run it
// through the existing /anonymize/text detection, and map the returned
// character offsets back to on-page bounding boxes so the caller can draw a
// highlight overlay and burn a real redaction into a downloadable PDF.
//
// Two extraction paths, chosen per page:
//   - A PDF page with a real text layer: pdf.js gives exact word positions
//     for free (already a dependency here, used for the Assistant's file
//     reader) — no OCR needed.
//   - A scanned PDF page or a plain image: no text layer exists, so
//     tesseract.js (client-side OCR, vendored locally — see public/
//     tesseract-worker.min.js and public/tessdata) provides word-level
//     bounding boxes instead.
//
// Runs entirely in the browser (matching utils/attachments.js): OCR is too
// slow for a Catalyst function without risking a timeout, and round-tripping
// the file to the server would double the transfer for no gain.

export const MAX_PAGES = 15;
// Per-page ceiling on the pdf.js/Tesseract calls below. Extraction can hang
// rather than reject if the underlying engine gets stuck (observed in one
// environment on a worker-script load that a plain fetch() of the identical
// URL completed instantly — narrow enough that the exact trigger wasn't
// worth chasing further, but broad enough that hanging forever with no
// feedback is not acceptable) — a bounded, clearly-reported failure for one
// page beats a silently frozen upload button.
const PAGE_TIMEOUT_MS = 25000;
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
  ]);
}
// Redaction boxes are burned onto the page raster at this padding (px) on
// every side beyond the token's measured box — better to redact a shade too
// much than leave a sliver of the original text visible at the edge.
const REDACTION_PAD = 3;

function fileKind(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) return 'pdf';
  if (/^image\//.test(file.type)) return 'image';
  return null;
}

// ── Pure logic: flattening tokens into one string, and mapping backend
// offsets back to the tokens that produced them. No DOM/canvas/pdf.js here,
// so this half is unit-testable without a browser. ──────────────────────────

// Joins every page's tokens into one string (single space between tokens),
// recording the [start, end) character range each token occupies in that
// string. This exact string — not a copy, not a re-join — is what must be
// sent to /anonymize/text, since the returned redaction offsets are only
// meaningful against the string the server actually saw.
export function buildFlatText(pages) {
  let flatText = '';
  const spans = [];
  pages.forEach((page, pageIndex) => {
    page.tokens.forEach((token, tokenIndex) => {
      if (flatText) flatText += ' ';
      const start = flatText.length;
      flatText += token.text;
      spans.push({ start, end: flatText.length, pageIndex, tokenIndex });
    });
  });
  return { flatText, spans };
}

// For each backend-reported redaction span (offsets into the flatText
// buildFlatText produced), finds every token whose own span overlaps it —
// a multi-word entity like "Ravi Kumar" covers two tokens, both need
// covering. Returns one entry per covered token, deduplicated, keeping the
// first redaction type seen for a token if more than one span touches it.
export function mapRedactionsToTokens(redactions, spans) {
  const covered = new Map();
  for (const r of redactions || []) {
    for (const s of spans) {
      const overlaps = s.start < r.end && r.start < s.end;
      if (!overlaps) continue;
      const key = `${s.pageIndex}:${s.tokenIndex}`;
      if (!covered.has(key)) {
        covered.set(key, { pageIndex: s.pageIndex, tokenIndex: s.tokenIndex, type: r.type });
      }
    }
  }
  return [...covered.values()];
}

// ── Browser-dependent extraction. Not unit-testable without a real PDF/
// canvas/Tesseract runtime — verify these live. ─────────────────────────────

async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist');
  // Same vendored-worker reasoning as utils/attachments.js: this app's CSP
  // (worker-src 'self' blob:) has no CDN allowlisted, so the worker script
  // must be served from this origin, not pdfjs-dist's default CDN path.
  pdfjs.GlobalWorkerOptions.workerSrc = `${process.env.PUBLIC_URL || ''}/pdf.worker.min.js`;
  return pdfjs;
}

let tesseractWorkerPromise = null;
// One shared worker for the whole extraction run rather than one per page —
// spinning up the WASM core is the expensive part.
function getTesseractWorker(onProgress) {
  if (tesseractWorkerPromise) return tesseractWorkerPromise;
  tesseractWorkerPromise = (async () => {
    const { createWorker } = await import('tesseract.js');
    const base = process.env.PUBLIC_URL || '';
    const worker = await createWorker('eng', 1, {
      workerPath: `${base}/tesseract-worker.min.js`,
      corePath: `${base}/tesseract-core-lstm.wasm.js`,
      langPath: `${base}/tessdata`,
      gzip: true,
      // tesseract.js defaults to wrapping the worker script in a blob: URL
      // (importScripts from inside a Blob) to dodge CORS when workerPath
      // points at a CDN. That indirection breaks the WASM core's own
      // relative lookup of its .wasm binary — inside the blob, it can no
      // longer tell it's really being served from this origin — which
      // hangs forever at "initializing tesseract" with no error. Everything
      // here is already same-origin (vendored into public/, not a CDN), so
      // the workaround isn't needed and only causes the hang.
      workerBlobURL: false,
      logger: (m) => {
        if (!onProgress) return;
        const pct = Math.round((m.progress || 0) * 100);
        onProgress(m.status === 'recognizing text' ? `Reading scanned page — ${pct}%` : `${m.status}… ${pct}%`);
      },
    });
    return worker;
  })();
  return tesseractWorkerPromise;
}

export async function terminateOcr() {
  if (!tesseractWorkerPromise) return;
  const worker = await tesseractWorkerPromise;
  tesseractWorkerPromise = null;
  await worker.terminate();
}

// Renders a pdf.js page to a canvas at the given scale. Used both as the
// visible page image and, when the page has no text layer, as the OCR
// source.
async function renderPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

// pdf.js text items carry a transform matrix in PDF space (origin bottom-
// left, y up); combining it with the viewport's own transform converts
// straight to canvas-pixel space (origin top-left, y down) — the same space
// renderPageToCanvas just drew into, at the same scale.
function pdfTextLayerTokens(pdfjs, content, viewport) {
  const tokens = [];
  for (const item of content.items) {
    const str = (item.str || '').trim();
    if (!str) continue;
    const m = pdfjs.Util.transform(viewport.transform, item.transform);
    const scale = viewport.scale || 1;
    const width = item.width * scale;
    const height = (item.height || 10) * scale;
    const x = m[4];
    const y = m[5] - height; // m[5] is the text baseline; lift to the box's top edge
    tokens.push({ text: str, x, y, width, height });
  }
  return tokens;
}

// tesseract.js v7 nests word-level data as blocks -> paragraphs -> lines ->
// words rather than a flat array (README: "Use `blocks` output to generate
// granular data [word/symbol level]") — recognize() must be asked for it
// explicitly (`{ blocks: true }`) or `data.blocks` is null and there is
// nothing to flatten.
function flattenWords(blocks) {
  const words = [];
  for (const block of blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        words.push(...(line.words || []));
      }
    }
  }
  return words;
}

function ocrWordsToTokens(words) {
  return (words || [])
    .filter((w) => (w.text || '').trim())
    .map((w) => ({
      text: w.text.trim(),
      x: w.bbox.x0,
      y: w.bbox.y0,
      width: w.bbox.x1 - w.bbox.x0,
      height: w.bbox.y1 - w.bbox.y0,
    }));
}

// Extracts every page of a PDF or image file into { canvas, width, height,
// tokens, ocr }. `ocr` marks pages that had no usable text layer and went
// through Tesseract instead — surfaced to the caller so a slower/lower-
// confidence page can be labelled as such.
export async function extractDocument(file, onProgress) {
  const kind = fileKind(file);
  if (!kind) throw new Error('Only PDF and image files are supported.');

  const pages = [];
  const scale = 2; // OCR and on-screen legibility both want more than 1x

  if (kind === 'image') {
    if (onProgress) onProgress(`Reading ${file.name}…`);
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const worker = await getTesseractWorker(onProgress);
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    pages.push({ canvas, width: canvas.width, height: canvas.height, tokens: ocrWordsToTokens(flattenWords(data.blocks)), ocr: true });
    return { pages };
  }

  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  // Unlike utils/attachments.js's text-only extraction, this also calls
  // page.render() to a canvas — a heavier operation than getTextContent(),
  // and disableWorker (justified there as "fast enough on the main thread
  // for text extraction") hung indefinitely here instead of erroring.
  // A real worker is vendored same-origin (public/pdf.worker.min.js,
  // reachable, CSP already allows worker-src 'self'), so there's no reason
  // to force everything onto the main thread in the first place.
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pageCount = Math.min(doc.numPages, MAX_PAGES);

  for (let i = 1; i <= pageCount; i++) {
    if (onProgress) onProgress(`Reading page ${i} of ${pageCount}…`);
    // eslint-disable-next-line no-await-in-loop
    const page = await withTimeout(doc.getPage(i), PAGE_TIMEOUT_MS, `Loading page ${i}`);
    const viewport = page.getViewport({ scale });
    // eslint-disable-next-line no-await-in-loop
    const canvas = await withTimeout(renderPageToCanvas(page, scale), PAGE_TIMEOUT_MS, `Rendering page ${i}`);
    // eslint-disable-next-line no-await-in-loop
    const content = await withTimeout(page.getTextContent(), PAGE_TIMEOUT_MS, `Reading text on page ${i}`);
    const textLayerTokens = pdfTextLayerTokens(pdfjs, content, viewport);

    if (textLayerTokens.length > 0) {
      pages.push({ canvas, width: canvas.width, height: canvas.height, tokens: textLayerTokens, ocr: false });
    } else {
      // Scanned page — no text layer, fall back to OCR on the rendered image.
      // eslint-disable-next-line no-await-in-loop
      const worker = await getTesseractWorker(onProgress);
      // eslint-disable-next-line no-await-in-loop
      const { data: ocrData } = await withTimeout(
        worker.recognize(canvas, {}, { blocks: true }), PAGE_TIMEOUT_MS, `Reading scanned page ${i}`
      );
      pages.push({ canvas, width: canvas.width, height: canvas.height, tokens: ocrWordsToTokens(flattenWords(ocrData.blocks)), ocr: true });
    }
  }
  return { pages, notePages: doc.numPages > pageCount ? `first ${pageCount} of ${doc.numPages} pages` : '' };
}

// Draws solid redaction boxes for every covered token directly onto each
// page's own canvas (mutates in place) — burning the redaction into the
// pixels rather than layering a shape on top of live text/vector content is
// the only way to guarantee nothing recoverable survives underneath.
export function burnRedactions(pages, coveredTokens) {
  const byPage = new Map();
  for (const c of coveredTokens) {
    if (!byPage.has(c.pageIndex)) byPage.set(c.pageIndex, []);
    byPage.get(c.pageIndex).push(c);
  }
  pages.forEach((page, pageIndex) => {
    const covers = byPage.get(pageIndex);
    if (!covers || !covers.length) return;
    const ctx = page.canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    for (const c of covers) {
      const t = page.tokens[c.tokenIndex];
      if (!t) continue;
      ctx.fillRect(t.x - REDACTION_PAD, t.y - REDACTION_PAD, t.width + REDACTION_PAD * 2, t.height + REDACTION_PAD * 2);
    }
  });
}

// Assembles the (already-redacted) page canvases into a single downloadable
// PDF. pdf.js only reads PDFs, so writing one back out needs pdf-lib — each
// page becomes a flattened JPEG image, which also means there is no
// underlying text layer left in the output at all, not just in the
// redacted regions.
// canvas.toBlob() rather than toDataURL()+fetch(): this app's CSP has a
// strict connect-src allowlist with no `data:` entry, so fetching a data:
// URL to get its bytes back (the usual shortcut) is silently blocked —
// "TypeError: Failed to fetch" with no CSP violation report to explain it.
// toBlob()/Blob.arrayBuffer() never touches the network at all.
function canvasToJpegBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { reject(new Error('canvas.toBlob failed')); return; }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/jpeg', 0.92);
  });
}

export async function buildRedactedPdf(pages) {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (const page of pages) {
    // eslint-disable-next-line no-await-in-loop
    const jpegBytes = await canvasToJpegBytes(page.canvas);
    // eslint-disable-next-line no-await-in-loop
    const image = await pdf.embedJpg(jpegBytes);
    const pdfPage = pdf.addPage([page.width, page.height]);
    pdfPage.drawImage(image, { x: 0, y: 0, width: page.width, height: page.height });
  }
  return pdf.save();
}
