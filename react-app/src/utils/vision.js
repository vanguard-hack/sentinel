// Client half of the Fast Vision Pre-Parser.
//
// The parse is kicked off the moment a file is attached, not when the message
// is sent. An officer photographing an FIR then typing "what section is this
// under?" gives us several seconds of free time; spending the vision budget
// there means send feels instant. By the time they hit send the digest is
// usually already waiting, and if it isn't, sending simply awaits the
// in-flight promise rather than starting a second one.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

async function toHex(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

// Zia's vision services read JPEG and PNG. Anything else (PDF, HEIC, docx)
// is attached without a digest rather than sent to fail — the officer still
// sees their file on the message, and the assistant is told plainly that it
// could not read it.
export const canPreParse = (file) =>
  !!file && /^image\/(jpeg|png)$/.test(file.type) && file.size <= 8 * 1024 * 1024;

// Returns a digest, or null when the image could not be parsed. Never throws:
// a failed pre-parse must not stop the officer from sending their message.
export async function preParseImage(file, { signal } = {}) {
  if (!canPreParse(file)) return null;
  try {
    const qs = new URLSearchParams({ mime: file.type, filename: file.name || 'image.jpg' }).toString();
    const res = await fetch(`/server/rag/vision/parse?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: await toHex(file),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.digest) return null;
    return data.digest;
  } catch {
    return null;
  }
}

// A one-line status for the attachment chip, so the officer can see the image
// was actually read rather than silently ignored.
export function digestLabel(digest) {
  if (!digest) return null;
  if (digest.ok === false) return 'unreadable';
  if (digest.doc_type) return digest.doc_type;
  if (digest.text) return 'text read';
  if (digest.objects && digest.objects.length) return digest.objects[0];
  return 'no text found';
}
