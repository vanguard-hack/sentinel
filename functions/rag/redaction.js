// Dual-tier redaction.
//
// Tier 1 — Pre-retrieval: strip fields the caller may not see BEFORE rows or
// document excerpts are assembled into the model's context. This is the tier
// that matters. Once sensitive data is in the prompt the model has seen it,
// and it can resurface through paraphrase, a later turn, an injected
// instruction, or the request log — redacting only the final answer would be
// closing the door after the fact.
//
// Tier 2 — Post-generation: a second pass over the finished answer, catching
// what the model inferred or restated rather than copied. Tier 2 is a
// backstop, never the primary control.
//
// Both tiers report what they removed so the audit trail records the decision,
// not just the outcome.

// Fields carrying identity, ordered from most to least sensitive. A role sees
// a field only if its clearance is at or above the field's tier.
const FIELD_TIERS = {
  // Direct identifiers of private individuals.
  VictimName: 3,
  ComplainantName: 3,
  AccusedName: 2,
  // Locators — a precise coordinate plus a name identifies a household.
  latitude: 2,
  longitude: 2,
  // Free text routinely contains names, addresses and phone numbers.
  BriefFacts: 2,
};

// Clearance by role. Analysts and policymakers work with aggregates and trends
// and have no operational need for the identity of a victim or complainant;
// investigators and above do.
const ROLE_CLEARANCE = {
  admin: 3,
  supervisor: 3,
  investigator: 3,
  analyst: 1,
  policymaker: 1,
};

const clearanceOf = (role) => ROLE_CLEARANCE[role] ?? 0;

const REDACTED = '[redacted]';

// ── Tier 1 ──────────────────────────────────────────────────────────────────

// Redact rows before they reach the model. Returns the rows plus a record of
// which fields were removed and why.
function filterRows(rows, role) {
  const clearance = clearanceOf(role);
  const removed = new Map();
  const out = (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const copy = {};
    for (const [k, v] of Object.entries(row)) {
      const tier = FIELD_TIERS[k];
      if (tier !== undefined && clearance < tier) {
        copy[k] = REDACTED;
        removed.set(k, (removed.get(k) || 0) + 1);
      } else {
        copy[k] = v;
      }
    }
    return copy;
  });
  return {
    rows: out,
    redactions: [...removed.entries()].map(([field, count]) => ({ field, count, tier: FIELD_TIERS[field] })),
  };
}

// Free-text excerpts (OCR'd scans, document chunks) can't be filtered by field,
// so identifiers are matched by shape instead.
const PATTERNS = [
  // Aadhaar: 12 digits, usually spaced 4-4-4. Checked before the generic
  // number rules so it is not mistaken for a phone number.
  { name: 'aadhaar', tier: 2, re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g },
  // Indian mobile numbers, with or without +91.
  { name: 'phone', tier: 2, re: /(?:\+?91[ -]?)?\b[6-9]\d{9}\b/g },
  { name: 'email', tier: 2, re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // PAN — identity document, same tier as Aadhaar.
  { name: 'pan', tier: 2, re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
];

function filterText(text, role) {
  const clearance = clearanceOf(role);
  let out = String(text == null ? '' : text);
  const redactions = [];
  for (const p of PATTERNS) {
    if (clearance >= p.tier) continue;
    let count = 0;
    out = out.replace(p.re, () => { count++; return `[${p.name} redacted]`; });
    if (count) redactions.push({ field: p.name, count, tier: p.tier });
  }
  return { text: out, redactions };
}

// ── Tier 2 ──────────────────────────────────────────────────────────────────

// Applied to the finished answer. Uses the same shape-matching, so an
// identifier the model reproduced from context — or inferred — is caught even
// though tier 1 already ran.
function guardAnswer(answer, role) {
  const { text, redactions } = filterText(answer, role);
  return { answer: text, redactions };
}

// Flatten redaction records into audit-friendly strings.
const describe = (redactions) =>
  (redactions || []).map((r) => `${r.field}x${r.count}`).join(',');

module.exports = {
  FIELD_TIERS,
  ROLE_CLEARANCE,
  clearanceOf,
  filterRows,
  filterText,
  guardAnswer,
  describe,
};
