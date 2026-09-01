// What an attachment in the composer actually gives the assistant.
//
// Attaching a file and having nothing happen is the worst version of this
// feature: the officer sees their seizure list sitting on the message, asks
// "what's the total value here?", and gets an answer drawn from everything
// except the file in front of them. So a file attached to a question is READ
// in the browser and its text travels with the question as context — the same
// extraction Records already uses to file a document, run for one message
// instead.
//
// Everything happens client-side. The parsing is format work, not
// intelligence, and doing it here keeps large files off the function's request
// budget entirely — only the extracted text is sent.
//
// The status each file reports back is not decoration. An officer has to be
// able to tell, before they hit send, whether the assistant will actually see
// what they attached; a chip that looks the same whether the file was read or
// silently dropped is how you end up trusting an answer that never saw it.

import { detectKind } from './extract';

// Per file. Generous enough for a statement or a seizure list, small enough
// that four of them still leave the model room to think.
export const MAX_CONTEXT_CHARS = 6000;
// Beyond this the browser tab, not the assistant, becomes the problem.
export const MAX_READ_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 30;

// How a file will be used, decided from the file alone so the chip can say so
// the moment it is attached rather than after a round trip.
//   image     — read by the vision pre-parser (OCR + objects)
//   document  — text extracted here and sent as context
//   audio     — transcribed and read as context, exactly like a document
//   unusable  — nothing can be read from it; it rides along as a filename only
export function contextKind(file) {
  if (!file) return 'unusable';
  if (/^image\//.test(file.type)) return 'image';
  if (/^audio\//.test(file.type)) return 'audio';
  if (file.size > MAX_READ_BYTES) return 'unusable';
  const kind = detectKind(file);
  if (kind === 'pdf' || kind === 'sheet' || kind === 'word' || kind === 'slides' || kind === 'text') {
    return 'document';
  }
  return 'unusable';
}

// Why a file will not be read, in the officer's terms. Vague is useless here:
// "unsupported" leaves someone guessing whether the file was too big, the
// wrong format, or simply lost.
export function unusableReason(file) {
  if (!file) return 'could not be read';
  if (file.size > MAX_READ_BYTES) return 'too large to read here';
  const kind = detectKind(file);
  if (kind === 'video') return 'video — file it in Records to transcribe it';
  if (kind === 'legacy') return 'old Office format — re-save as .docx, .xlsx or .pptx';
  return 'this file type cannot be read';
}

// A PDF's embedded text, which is what a typed PDF — an SOP, a form, a
// generated report — actually contains.
//
// Deliberately NOT the Records pipeline, which rasterises every page and OCRs
// it. That is right for a scan of paper and far too slow for a question typed
// into a chat box. A PDF with no embedded text is reported as such rather than
// quietly OCR'd, so the officer is told to file it in Records instead of
// waiting on something that is not happening.
async function pdfText(file, onProgress) {
  const pdfjs = await import('pdfjs-dist');
  // Same as the Records pipeline: CRA does not emit the worker as a separate
  // asset, and text extraction is fast enough on the main thread.
  pdfjs.GlobalWorkerOptions.workerSrc = '';
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
  const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
  const out = [];
  let chars = 0;
  for (let i = 1; i <= pages && chars < MAX_CONTEXT_CHARS; i++) {
    // eslint-disable-next-line no-await-in-loop
    const page = await doc.getPage(i);
    // eslint-disable-next-line no-await-in-loop
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    if (text) {
      out.push(text);
      chars += text.length;
    }
    if (onProgress) onProgress(`Reading ${file.name} — page ${i} of ${pages}…`);
  }
  return {
    text: out.join('\n\n'),
    note: doc.numPages > pages ? `first ${pages} of ${doc.numPages} pages` : '',
  };
}

// Read one attached file into context. Never throws: a file that cannot be
// read must not stop the officer sending their question.
export async function readForContext(file, { onProgress, transcribe } = {}) {
  const base = { name: file.name, size: file.size, mime: file.type || '' };
  try {
    const kind = detectKind(file);
    if (kind === 'pdf') {
      const { text, note } = await pdfText(file, onProgress);
      if (!text.trim()) {
        return {
          ...base,
          kind: 'pdf',
          ok: false,
          reason: 'scanned PDF with no embedded text — file it in Records to OCR it',
        };
      }
      return { ...base, kind: 'pdf', ok: true, text: text.slice(0, MAX_CONTEXT_CHARS), note };
    }

    // Office formats and plain text go through the same reader Records uses.
    // The reader itself is small; the spreadsheet parser it reaches for is not,
    // and stays behind its own dynamic import inside extractText — so a
    // conversation with no spreadsheet in it never downloads one.
    const { extractText } = await import('./extract');
    const { text, tables, note } = await extractText(file, { onProgress, transcribe });
    if (!String(text || '').trim() && !(tables || []).length) {
      return { ...base, kind, ok: false, reason: 'no readable text in this file' };
    }
    return {
      ...base,
      kind,
      ok: true,
      text: String(text || '').slice(0, MAX_CONTEXT_CHARS),
      // Two small tables are worth more to the model than the prose around
      // them; more than that is a spreadsheet, and the text carries it.
      tables: (tables || []).slice(0, 2),
      note: note || '',
    };
  } catch (e) {
    return { ...base, kind: 'unusable', ok: false, reason: (e && e.message) || 'could not be read' };
  }
}

// The chip's status line — what this file is doing for this question.
export function contextLabel(a) {
  if (!a) return '';
  if (a.reading) return 'reading…';
  if (a.kind === 'image') {
    if (!a.parsed) return 'reading…';
    return a.digest ? 'read as context' : 'not readable';
  }
  if (a.kind === 'document' || a.kind === 'audio') {
    if (!a.context) return 'not readable';
    if (!a.context.ok) return 'not readable';
    return a.kind === 'audio' ? 'transcribed and read as context' : 'read as context';
  }
  return 'not sent as context';
}

// The detail behind that status, for the chip's tooltip and the summary line.
export function contextDetail(a) {
  if (!a) return '';
  if (a.kind === 'image') {
    if (!a.parsed) return 'Reading the image…';
    if (!a.digest) return 'This image could not be read; it is attached by name only.';
    return 'Read by the vision pre-parser and sent with your question.';
  }
  if (a.kind === 'document' || a.kind === 'audio') {
    // While a long PDF is being read the per-page progress is more useful than
    // a generic "reading", and it is the only sign the tab has not hung.
    if (a.reading) return a.detail || (a.kind === 'audio' ? 'Transcribing the recording…' : 'Reading the document…');
    if (!a.context || !a.context.ok) {
      return `Not sent as context — ${(a.context && a.context.reason) || 'this file could not be read'}.`;
    }
    const chars = (a.context.text || '').length;
    return `${chars.toLocaleString()} characters sent with your question`
      + (a.context.note ? ` (${a.context.note}).` : '.');
  }
  return `Not sent as context — ${a.reason || 'this file type cannot be read'}.`;
}

// Which of the three states a chip is in, for styling. Kept beside the labels
// so the words and the colour can never drift apart.
export function attachState(a) {
  if (!a) return 'skipped';
  if (a.reading || (a.kind === 'image' && !a.parsed)) return 'reading';
  if (a.kind === 'image') return a.digest ? 'ready' : 'skipped';
  if (a.kind === 'document') return a.context && a.context.ok ? 'ready' : 'skipped';
  return 'skipped';
}

// One line for the whole tray: what the assistant will actually receive.
// Written for the moment before send, which is when it matters.
export function contextSummary(list) {
  const all = list || [];
  if (!all.length) return null;
  const reading = all.filter((a) => attachState(a) === 'reading').length;
  const ready = all.filter((a) => attachState(a) === 'ready').length;
  const skipped = all.length - reading - ready;
  if (reading) {
    return { tone: 'reading', text: `Reading ${reading} file${reading === 1 ? '' : 's'}…` };
  }
  if (!ready) {
    return {
      tone: 'skipped',
      text: `${skipped === 1 ? 'This file' : `These ${skipped} files`} can't be read, so `
        + `${skipped === 1 ? 'it' : 'they'} won't be sent as context.`,
    };
  }
  return {
    tone: skipped ? 'partial' : 'ready',
    text: `${ready} file${ready === 1 ? '' : 's'} will be sent as context with your question`
      + (skipped ? `; ${skipped} can't be read.` : '.'),
  };
}
