// PDF export helpers — reading the server's response and handing the officer
// the file.
//
// One thing this makes impossible: an export that silently does not happen.
// A download that just never arrives is the worst outcome available, because
// the officer assumes it worked. Every failure path here throws with a reason
// the UI can show.

/**
 * Interpret a /report-pdf response.
 *
 * Server-rendered exports (Report Studio, case diary, investigation summary)
 * all come back through this one shape, so the callers do not each invent
 * their own reading of it.
 */
export async function readPdfResponse(res) {
  const data = await res.json().catch(() => ({}));
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
