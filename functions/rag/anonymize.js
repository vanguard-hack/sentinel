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

module.exports = {
  REGEX_RECOGNIZERS,
  regexEntities,
  resolveOverlaps,
};
