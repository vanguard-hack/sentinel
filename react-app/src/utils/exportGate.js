// Export control — the client half.
//
// The decision itself is the server's (functions/rag/exportscreen.js); nothing
// here judges a document. This module's job is to turn the server's verdict
// into something the officer can act on, and to make one thing impossible: an
// export that silently does not happen. A download that just never arrives is
// the worst outcome available, because the officer assumes it worked.
//
// Three shapes come back from the server and each maps to a different thing
// the officer needs to be told:
//
//   200 cleared          → the file downloads, as it always did
//   202 pending_approval → held; show the reasons, hand back an approval id
//   403 refused          → the approval was rejected, expired or does not fit
//                          this document; say which

/** A held export. Carries what the UI needs to explain the hold. */
export class ExportHeldError extends Error {
  constructor({ approvalId, reasons, message }) {
    super(message || 'This export needs supervisor approval.');
    this.name = 'ExportHeldError';
    this.held = true;
    this.approvalId = approvalId;
    this.reasons = reasons || [];
  }
}

/** An approval that cannot be redeemed — rejected, expired, or the wrong document. */
export class ExportRefusedError extends Error {
  constructor(message) {
    super(message || 'This export was not approved.');
    this.name = 'ExportRefusedError';
    this.refused = true;
  }
}

const post = (path, body) =>
  fetch(`/server/rag/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * Interpret a /report-pdf response, throwing the typed errors above so every
 * caller handles a hold the same way instead of each inventing its own.
 *
 * Server-rendered exports (Report Studio, case diary, investigation summary)
 * are screened inside handleReportPdf, so this is purely about presenting the
 * outcome — the enforcement already happened.
 */
export async function readPdfResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (res.status === 202 && data.status === 'pending_approval') {
    throw new ExportHeldError(data);
  }
  if (res.status === 403 && data.status === 'refused') {
    throw new ExportRefusedError(data.error);
  }
  if (!res.ok || !data.pdf) {
    throw new Error(data.error || `PDF export failed (HTTP ${res.status})`);
  }
  return data;
}

/** base64 → a downloaded file. */
export function downloadBase64Pdf(b64, filename) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Screen an export the BROWSER renders (the dashboard snapshot and the
 * assistant transcript, both html2canvas).
 *
 * Being straight about the difference: server-rendered exports pass through a
 * route that will not return bytes without clearing the screen, so the check
 * cannot be avoided. These two are rasterised locally, so this call is a check
 * the client makes on itself — someone editing their own JavaScript could skip
 * it. It still belongs here: it catches the accidental export, which is what
 * this feature is for, and the hold is recorded server-side either way. The UI
 * never claims more than that.
 */
export async function screenClientExport({ text, html, kind, title, approvalId }) {
  let res;
  try {
    res = await post('export/screen', { text, html, kind, title, approvalId });
  } catch {
    // The screen is a control, not a dependency. If it cannot be reached the
    // export proceeds — blocking an officer's work because a check was
    // unreachable trades a small privacy risk for a large operational one, and
    // an export nobody can perform is how a control gets switched off.
    return { cleared: true, unreachable: true };
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 202 && data.status === 'pending_approval') throw new ExportHeldError(data);
  if (res.status === 403) throw new ExportRefusedError(data.error);
  // A reachable server that answered with anything else is NOT a clearance.
  // The 503 case is the one that matters: the server screened the document,
  // found it sensitive, and could not open a hold for it. Treating that as
  // "cleared" because it was not a 202 would release the one document the
  // screen had just decided needed a second signature.
  if (!res.ok) throw new ExportRefusedError(data.error || `Export blocked (HTTP ${res.status})`);
  return { cleared: true };
}

/** Collect the visible text of a DOM subtree, for screening a rendered export. */
export const visibleText = (el) => (el ? String(el.innerText || el.textContent || '') : '');

// ── Supervisor queue ───────────────────────────────────────────────────────

export async function fetchExportRequests(status = 'pending') {
  const res = await post('export/pending', { status });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Could not load requests (HTTP ${res.status})`);
  return data.requests || [];
}

export async function decideExport(approvalId, decision, note) {
  const res = await post('export/decide', { approvalId, decision, note });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Could not record the decision (HTTP ${res.status})`);
  return data.request;
}

export async function fetchExportStatus(approvalId) {
  const res = await post('export/status', { approvalId });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not check the request');
  return data.request;
}

// ── Review loop ────────────────────────────────────────────────────────────
//
// Both sides of a review use these: the supervisor raising and resolving
// threads, and the officer who has to answer them. The server decides which of
// those the caller is — the client asking nicely is not a permission.

const reviewCall = async (path, body, what) => {
  const res = await post(path, body);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${what} (HTTP ${res.status})`);
  return data;
};

export const fetchExportReview = (approvalId) =>
  reviewCall('export/review', { approvalId }, 'Could not open the review');

export const addReviewThread = (approvalId, { start, end, quote, body, finding }) =>
  reviewCall('export/thread', { approvalId, start, end, quote, body, finding }, 'Could not add the comment');

export const addReviewComment = (approvalId, threadId, body) =>
  reviewCall('export/comment', { approvalId, threadId, body }, 'Could not add the comment');

export const resolveReviewThread = (approvalId, threadId, resolved = true) =>
  reviewCall('export/resolve', { approvalId, threadId, resolved }, 'Could not resolve the comment');

export const annotateExportReview = (approvalId) =>
  reviewCall('export/annotate', { approvalId }, 'Could not draft notes');

export const requestExportChanges = (approvalId, note) =>
  reviewCall('export/changes', { approvalId, note }, 'Could not return the request');

/**
 * Where a highlight sits, as character offsets into the reviewed text.
 *
 * Overlapping findings are merged rather than nested: two rules matching the
 * same words must not produce two stacked <mark> elements the reviewer has to
 * peel apart to read the sentence underneath.
 */
export function highlightSpans(findings = [], threads = []) {
  const spans = [
    ...findings.map((f) => ({ start: f.start, end: f.end, kind: 'finding', ref: f })),
    ...threads
      .filter((t) => !t.outdated)
      .map((t) => ({
        start: t.anchor.start, end: t.anchor.end,
        kind: t.resolved ? 'resolved' : 'open', ref: t,
      })),
  ]
    .filter((s) => Number.isFinite(s.start) && s.end > s.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const out = [];
  for (const s of spans) {
    const prev = out[out.length - 1];
    if (prev && s.start < prev.end) {
      // An open thread outranks a resolved one, which outranks a bare finding:
      // the reviewer needs to see what still needs an answer.
      const rank = { open: 3, resolved: 2, finding: 1 };
      if (rank[s.kind] > rank[prev.kind]) prev.kind = s.kind;
      if (s.kind !== 'finding') prev.threads = [...(prev.threads || []), s.ref];
      prev.end = Math.max(prev.end, s.end);
      continue;
    }
    out.push({ ...s, threads: s.kind === 'finding' ? [] : [s.ref] });
  }
  return out;
}

/** Split text into rendered pieces, each either plain or highlighted. */
export function segmentText(text = '', spans = []) {
  const pieces = [];
  let at = 0;
  for (const s of spans) {
    if (s.start > at) pieces.push({ text: text.slice(at, s.start), span: null });
    pieces.push({ text: text.slice(s.start, s.end), span: s });
    at = s.end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at), span: null });
  return pieces;
}
