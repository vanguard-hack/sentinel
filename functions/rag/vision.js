// Fast Vision Pre-Parser.
//
// A cheap, deterministic first pass over an attached image. It runs Zia's
// vision services in PARALLEL and reduces their output to a compact digest the
// assistant can reason over as text.
//
// "Fast" is the whole point, and it is bought three ways:
//   • No LLM. Document type and salient fields come from regex over the OCR
//     text, not from a model call. Heuristics are wrong sometimes; they are
//     also ~500ms instead of ~8s, and the assistant still sees the raw text.
//   • Parallel, individually-budgeted service calls. One slow or broken Zia
//     service degrades its own field to null instead of sinking the digest.
//   • Run on attach, not on send. By the time the officer finishes typing,
//     the digest is already waiting, so the vision cost is hidden entirely.
//
// The digest is TEXT that will be placed in an LLM prompt, so it carries
// whatever was written on the paper — including identifiers. It must be passed
// through the clearance filter before it reaches a prompt, exactly like a
// database row. See redaction.filterText.

const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png' };

// Per-service budgets. OCR carries the most value so it gets the most room;
// the rest are enrichment and are dropped rather than waited on.
const BUDGET = { ocr: 12_000, objects: 6_000, barcode: 6_000, moderation: 6_000 };

const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ]);

// ── Heuristic classification ────────────────────────────────────────────────
// Ordered most to least specific: an FIR mentioning a seizure is an FIR.
const DOC_TYPES = [
  ['FIR', /\b(first information report|f\.?i\.?r\.?\b|u\/s\s*154|section\s*154\s*cr\.?p\.?c)/i],
  ['Chargesheet', /\b(charge[\s-]?sheet|final report|u\/s\s*173)/i],
  ['Seizure memo', /\b(seizure|panchnama|panch\s*witness|recovered (?:from|articles))/i],
  ['Arrest memo', /\b(arrest memo|memo of arrest|grounds of arrest)/i],
  ['Statement', /\b(statement of|u\/s\s*161|recorded the statement)/i],
  ['Post-mortem report', /\b(post[\s-]?mortem|autopsy|cause of death)/i],
  ['Medical report', /\b(medico[\s-]?legal|m\.?l\.?c\.?\b|injury report)/i],
  ['Summons / notice', /\b(summons|notice u\/s|you are hereby (?:directed|required))/i],
  ['Identity document', /\b(aadhaar|आधार|permanent account number|driving licen[cs]e|passport)/i],
  ['Vehicle document', /\b(registration certificate|chassis no|engine no|insurance policy)/i],
];

function classify(text) {
  for (const [label, re] of DOC_TYPES) if (re.test(text)) return label;
  return null;
}

// Fields worth surfacing on their own line so the assistant does not have to
// hunt for them in a wall of OCR text.
const FIELDS = [
  ['crime_no', /\b(?:cr|crime|fir)[.\s]*no[.:\s]*([0-9]{1,5}\s*\/\s*(?:19|20)\d{2})/i],
  ['section', /\bu\/s[.:\s]*([0-9]{1,4}(?:\s*[,&/]\s*[0-9]{1,4})*(?:\s*(?:ipc|bns|crpc|bnss))?)/i],
  ['police_station', /\b(?:p\.?s\.?|police station)[.:\s]*([A-Za-z][A-Za-z\s]{2,30}?)(?:\s{2,}|,|\n|$)/i],
  ['date', /\b((?:0?[1-9]|[12]\d|3[01])[/-](?:0?[1-9]|1[0-2])[/-](?:19|20)?\d{2})\b/],
  ['vehicle_no', /\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{4})\b/],
];

function extractFields(text) {
  const out = {};
  for (const [key, re] of FIELDS) {
    const m = re.exec(text);
    if (m && m[1]) out[key] = m[1].replace(/\s+/g, ' ').trim();
  }
  return out;
}

// Zia's object labels are generic ("person", "car"). Only a handful carry
// investigative meaning; the rest are noise in a prompt and are dropped.
const NOTABLE = new Set([
  'person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'knife', 'gun',
  'cell phone', 'laptop', 'bottle', 'backpack', 'handbag', 'suitcase',
]);

function summariseObjects(result) {
  const objs = (result && result.objects) || [];
  const counts = new Map();
  for (const o of objs) {
    const label = String(o.object_type || '').toLowerCase();
    // Low-confidence detections are worse than no detection: they invite the
    // assistant to assert something that is not in the picture.
    if (!NOTABLE.has(label) || parseFloat(o.confidence) < 0.6) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => (n > 1 ? `${n} ${label}s` : label));
}

// ── The pre-parse ───────────────────────────────────────────────────────────

// `zia` is app.zia(); `buf` the image bytes; `mime` a validated image type.
// Never throws — a digest with everything null is still a valid answer, and it
// tells the assistant honestly that the image could not be read.
async function preParse(zia, buf, mime, filename) {
  const ext = EXT_BY_MIME[mime] || 'jpg';
  const tmp = path.join(os.tmpdir(), `vision-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  const notes = [];
  try {
    fs.writeFileSync(tmp, buf);
  } catch (e) {
    return { filename, ok: false, error: 'could not stage image: ' + (e.message || e) };
  }

  // Each service gets its own read stream: a stream is consumed once, so
  // sharing one across parallel calls would starve all but the first.
  const stream = () => fs.createReadStream(tmp);
  const run = (label, fn, ms) =>
    withTimeout(Promise.resolve().then(fn), ms, label).catch((e) => {
      notes.push(`${label} unavailable (${(e && e.message) || e})`);
      return null;
    });

  const [ocr, objects, barcode, moderation] = await Promise.all([
    run('ocr', () => zia.extractOpticalCharacters(stream(), { modelType: 'OCR', language: 'eng' }), BUDGET.ocr),
    run('objects', () => zia.detectObject(stream()), BUDGET.objects),
    run('barcode', () => zia.scanBarcode(stream()), BUDGET.barcode),
    run('moderation', () => zia.moderateImage(stream()), BUDGET.moderation),
  ]);

  try { fs.unlinkSync(tmp); } catch { /* temp cleanup is best-effort */ }

  const text = ((ocr && ocr.text) || '').trim();
  const digest = {
    filename,
    ok: true,
    doc_type: classify(text),
    fields: extractFields(text),
    objects: summariseObjects(objects),
    barcode: (barcode && barcode.content) || null,
    // Advisory only, and deliberately NOT a block. Crime-scene and post-mortem
    // photographs are legitimately graphic; refusing to read police evidence
    // because it depicts violence would make the tool useless for the work it
    // exists to do. The flag tells the assistant to answer with care and lands
    // in the audit record.
    graphic: moderation && String(moderation.prediction || '').toLowerCase() !== 'safe'
      ? String(moderation.prediction)
      : null,
    // Trimmed: the digest goes into a prompt with a finite budget, and the
    // full scan is already stored by the Records feature if it was uploaded.
    text: text.slice(0, 4000),
    truncated: text.length > 4000,
    notes,
  };
  return digest;
}

// Render a digest as the prompt fragment the assistant actually sees. Kept
// separate from preParse so the redaction stage sits cleanly between them.
function digestToPrompt(d) {
  if (!d || d.ok === false) return `[Attached image "${d && d.filename}" could not be read.]`;
  const lines = [`Attached image: ${d.filename}`];
  if (d.doc_type) lines.push(`Looks like: ${d.doc_type}`);
  for (const [k, v] of Object.entries(d.fields || {})) lines.push(`${k.replace(/_/g, ' ')}: ${v}`);
  if (d.objects && d.objects.length) lines.push(`Visible in the photo: ${d.objects.join(', ')}`);
  if (d.barcode) lines.push(`Barcode/QR content: ${d.barcode}`);
  if (d.graphic) lines.push(`Note: flagged as ${d.graphic} — answer with appropriate care.`);
  if (d.text) lines.push(`Text read from the image${d.truncated ? ' (truncated)' : ''}:\n${d.text}`);
  else lines.push('No readable text was found in this image.');
  if (d.notes && d.notes.length) lines.push(`(Partial read: ${d.notes.join('; ')})`);
  return lines.join('\n');
}

module.exports = { preParse, digestToPrompt, classify, extractFields, summariseObjects, EXT_BY_MIME };
