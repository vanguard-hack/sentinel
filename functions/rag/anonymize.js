// PII anonymization: entity detection (regex + Zia NER), consistent
// per-call placeholder assignment, and reversible mapping helpers.
//
// Pure logic only — no HTTP, no auth, no Stratus I/O. That lives in
// index.js's handleAnonymize, the same split as guard.js / redaction.js.
//
// Modeled on the entity-detection design in
// github.com/Saurabhrajput1234/KSP_Project-Sherlock (regex recognizers layered
// over NER, overlap resolution, consistent instance-counter placeholders) —
// reimplemented for this codebase's stack (no Python/Presidio/spaCy here).

// Domain regex recognizers. Scored 1 so a deterministic domain pattern always
// wins an overlap against a fuzzy NER guess on the same span.
const REGEX_RECOGNIZERS = [
  { type: 'FIR_NUMBER', re: /\b\d{1,6}\/\d{4}\b/g, score: 1 },
  { type: 'PHONE', re: /\b[6-9]\d{9}\b/g, score: 1 },
  { type: 'DATE_TIME', re: /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\b/g, score: 1 },
  { type: 'DATE', re: /\b\d{2}[/-]\d{2}[/-]\d{4}\b/g, score: 1 },
];

function regexEntities(text) {
  const hits = [];
  for (const { type, re, score } of REGEX_RECOGNIZERS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      hits.push({ type, start: m.index, end: m.index + m[0].length, text: m[0], score });
      if (m[0].length === 0) re.lastIndex++; // guard against a zero-width pattern looping forever
    }
  }
  return hits;
}

// Greedy sweep: sort by start (ties broken by higher score first), keep an
// entity only if it doesn't overlap anything already kept. Equivalent in
// intent to the reference's overlap resolution (higher-confidence entity wins
// a conflict) but a single sorted pass instead of an O(n^2) pairwise scan.
function resolveOverlaps(entities) {
  const sorted = [...entities].sort((a, b) => a.start - b.start || b.score - a.score);
  const kept = [];
  for (const e of sorted) {
    const overlaps = kept.some((k) => e.start < k.end && k.start < e.end);
    if (!overlaps) kept.push(e);
  }
  return kept.sort((a, b) => a.start - b.start);
}

// Zia's NER response shape (functions/rag/node_modules/zcatalyst-sdk-node/
// lib/utils/pojo/zia.d.ts, ICatalystZiaNer): one array of {start_index,
// end_index, confidence_score, ner_tag, token} per input document. end_index's
// inclusive/exclusive convention isn't documented, so it is never used here —
// the end offset is derived from the token's own length instead, and an
// entity is kept only if that exact slice matches the token.
async function nerEntities(text, nerFn) {
  if (!text.trim()) return { entities: [], available: true };
  let resp;
  try {
    resp = await nerFn([text]);
  } catch {
    return { entities: [], available: false };
  }
  const general = (resp && resp[0] && resp[0].ner && resp[0].ner.general_entities) || [];
  const entities = [];
  for (const e of general) {
    const token = String(e.token || '');
    const start = Number(e.start_index);
    if (!token || !Number.isInteger(start) || start < 0) continue;
    const end = start + token.length;
    if (text.slice(start, end) !== token) continue; // offset doesn't match its own token — drop it
    entities.push({
      type: String(e.ner_tag || 'ENTITY').toUpperCase(),
      start, end, text: token,
      score: Math.min(Number(e.confidence_score) || 0.5, 0.99),
    });
  }
  return { entities, available: true };
}

// Consistent instance-counter anonymizer: the same (type, value) pair always
// gets the same placeholder within this call. Placeholders are assigned in
// first-appearance order, then spliced back-to-front so earlier offsets stay
// valid while later ones are replaced.
function anonymizeText(text, entities) {
  const byStart = [...entities].sort((a, b) => a.start - b.start);
  const map = {};
  const counts = {};
  for (const e of byStart) {
    const bucket = map[e.type] || (map[e.type] = {});
    if (!bucket[e.text]) {
      const idx = counts[e.type] || 0;
      bucket[e.text] = `${e.type}_${idx}`;
      counts[e.type] = idx + 1;
    }
  }
  let out = text;
  for (const e of [...byStart].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + map[e.type][e.text] + out.slice(e.end);
  }
  const entityCounts = Object.fromEntries(
    Object.entries(map).map(([type, bucket]) => [type, Object.keys(bucket).length])
  );
  return { anonymizedText: out, entityMap: map, entityCounts };
}

// Replaces every placeholder found in `text` with its original value. A
// single regex pass over all placeholders at once, word-boundary anchored —
// naive split/join per placeholder would let a short placeholder's substring
// (e.g. "PERSON_1") corrupt a longer one that hasn't been replaced yet (e.g.
// "PERSON_10"), since split/join has no boundary awareness. Works even when
// `text` isn't the anonymized output verbatim but a report or third-party
// document built from it — that's the point of keeping the map server-side
// rather than baking a one-shot substitution into the response.
function revealText(text, entityMap) {
  const byPlaceholder = {};
  for (const bucket of Object.values(entityMap || {})) {
    for (const [original, placeholder] of Object.entries(bucket)) {
      byPlaceholder[placeholder] = original;
    }
  }
  const placeholders = Object.keys(byPlaceholder);
  const out = String(text || '');
  if (!placeholders.length) return out;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b(?:${placeholders.map(escape).join('|')})\\b`, 'g');
  return out.replace(pattern, (m) => byPlaceholder[m] ?? m);
}

async function detectAndAnonymize(text, nerFn) {
  const regexHits = regexEntities(text);
  const { entities: nerHits, available } = await nerEntities(text, nerFn);
  const merged = resolveOverlaps([...regexHits, ...nerHits]);
  const { anonymizedText, entityMap, entityCounts } = anonymizeText(text, merged);
  return { anonymizedText, entityMap, entityCounts, nerAvailable: available };
}

module.exports = {
  REGEX_RECOGNIZERS,
  regexEntities,
  resolveOverlaps,
  nerEntities,
  anonymizeText,
  revealText,
  detectAndAnonymize,
};
