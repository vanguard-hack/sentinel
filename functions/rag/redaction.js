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
const i18n = require('./i18n');

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

// ── Coarsening: degrade rather than delete ──────────────────────────────────
//
// A coordinate was removed outright below its tier, which answers the privacy
// question by destroying the analytical one. An analyst asking where thefts
// cluster has no operational need for the doorstep, but every need for the
// neighbourhood, and `[redacted]` gives them neither — so the honest map
// simply stopped working for the roles that live in it.
//
// Rounding to one decimal place lands each incident on a ~11 km grid. District
// and city-scale clustering survives intact; a household does not, because
// every address within 11 km collapses onto the same point. The rounded value
// also states its own accuracy — 12.9 does not read as a doorstep the way
// 12.976543 does.
//
// `floor` is the clearance below which a field is still deleted rather than
// coarsened. An unrecognised caller (clearance 0) is not handed a coarse
// answer as a consolation prize; they get nothing, as before.
const COARSEN = {
  latitude: { floor: 1, precision: 1 },
  longitude: { floor: 1, precision: 1 },
};

const coarsen = (value, precision) => {
  // null, undefined and '' must pass through untouched. Number(null) is 0,
  // which is finite, so a missing coordinate would round to a real point off
  // the coast of Africa — a case plotted in the Atlantic is worse than a case
  // not plotted at all.
  if (value === null || value === undefined || value === '') return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const f = 10 ** precision;
  return Math.round(n * f) / f;
};

// ── Protected crimes: identity behind an explicit reason ───────────────────
//
// Publishing the identity of a victim of a sexual offence is itself an offence
// (BNS s.72, formerly IPC s.228A), POCSO s.23 forbids disclosure for a child
// victim, and Nipun Saxena v. Union of India (2018) extends that to anything
// from which identity could be worked out. Clearance alone is the wrong
// control here: the question is not whether an officer COULD see it but
// whether they have a reason to, on this case, today.
//
// So on these categories, victim and complainant identity is withheld from
// everyone — including admin — until a reason is stated. The reason is not
// validated, and is not meant to be: it is recorded. What deters misuse is
// that the access carries a name, a case and a stated purpose into a
// tamper-evident log, not that a string parser approved it.
//
// Matched on the enriched label AND the raw id, because rows reach this filter
// enriched on the ZCQL path and raw on others. Missing either would open the
// gap silently.
const PROTECTED_HEADS = new Set(['Crimes Against Women', 'Crimes Against Children']);
const PROTECTED_HEAD_IDS = new Set(['3', '4']);
const PROTECTED_SUBHEADS = new Set([
  'Rape', 'Molestation', 'Dowry Harassment', 'Child Sexual Assault', 'Child Kidnapping',
]);
// Identity of the person the offence was committed against. The accused is
// deliberately absent: naming a suspect is ordinary investigative work under
// the existing tiers, and the statutes above protect the victim.
const PROTECTED_FIELDS = new Set(['VictimName', 'ComplainantName']);
// Clearance still applies on top — a reason does not promote an analyst.
const PROTECTED_CLEARANCE = 3;

const PROTECTED_MARK = '[protected — state a reason for access]';

/** Is this row a case whose victim identity the statutes above shield? */
function isProtected(row) {
  if (!row || typeof row !== 'object') return false;
  const head = row.CrimeHead ?? row.CrimeMajorHead;
  const sub = row.CrimeSubHead ?? row.CrimeMinorHead;
  return (
    PROTECTED_HEADS.has(String(head))
    || PROTECTED_HEAD_IDS.has(String(row.CrimeMajorHeadID))
    || PROTECTED_SUBHEADS.has(String(sub))
  );
}

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

/**
 * Redact rows before they reach the model.
 *
 * `options.reason` is the officer's stated purpose for reaching protected
 * material. Absent — the normal case — protected identity is withheld and the
 * caller is told it can be unlocked by saying why. Present, and with the
 * clearance to match, it is released and the access is reported back for the
 * audit trail. It is never validated: the deterrent is the record, not a
 * string check.
 *
 * Returns `protectedAccess` whenever protected rows were involved at all, so
 * the caller writes an audit event for a REFUSED reach as well as a granted
 * one. An attempt that was blocked is the more interesting of the two.
 */
function filterRows(rows, role, options) {
  const clearance = clearanceOf(role);
  const reason = String((options && options.reason) || '').trim();
  const removed = new Map();
  const coarsened = new Map();
  let protectedRows = 0;
  let protectedFields = 0;

  const out = (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const guarded = isProtected(row);
    if (guarded) protectedRows++;
    const copy = {};
    for (const [k, v] of Object.entries(row)) {
      // Protected identity outranks the ordinary tier: on these cases even a
      // cleared officer must say why before the name is released.
      if (guarded && PROTECTED_FIELDS.has(k)
          && !(reason && clearance >= PROTECTED_CLEARANCE)) {
        copy[k] = PROTECTED_MARK;
        protectedFields++;
        continue;
      }
      const tier = FIELD_TIERS[k];
      if (tier !== undefined && clearance < tier) {
        const soft = COARSEN[k];
        if (soft && clearance >= soft.floor) {
          copy[k] = coarsen(v, soft.precision);
          coarsened.set(k, (coarsened.get(k) || 0) + 1);
        } else {
          copy[k] = REDACTED;
          removed.set(k, (removed.get(k) || 0) + 1);
        }
      } else {
        copy[k] = v;
      }
    }
    return copy;
  });

  const redactions = [
    ...[...removed.entries()].map(([field, count]) => ({ field, count, tier: FIELD_TIERS[field], action: 'redacted' })),
    ...[...coarsened.entries()].map(([field, count]) => ({
      field, count, tier: FIELD_TIERS[field], action: 'coarsened',
      detail: `rounded to ${COARSEN[field].precision} dp (~11 km)`,
    })),
  ];
  if (protectedFields) {
    redactions.push({ field: 'protected-identity', count: protectedFields, tier: PROTECTED_CLEARANCE, action: 'withheld' });
  }

  return {
    rows: out,
    redactions,
    ...(protectedRows ? {
      protectedAccess: {
        rows: protectedRows,
        fieldsWithheld: protectedFields,
        granted: protectedFields === 0 && !!reason,
        reason: reason || null,
        cleared: clearance >= PROTECTED_CLEARANCE,
      },
    } : {}),
  };
}

/**
 * What to tell the officer when protected identity was withheld.
 *
 * Two different refusals, and conflating them would waste an officer's time:
 * one is unlockable by stating a purpose, the other is not unlockable at all
 * at their clearance and no amount of typing will change it.
 */
function protectedNotice(access, lang) {
  if (!access || !access.fieldsWithheld) return null;
  // Fixed text, so it comes from the string table rather than a translation
  // call. A legal sentence re-worded slightly differently on every request is
  // worse than one written once and checked once — and a provider outage must
  // not silently revert this particular notice to English.
  return i18n.t(access.cleared ? 'protected.unlockable' : 'protected.blocked', lang);
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
  COARSEN,
  PROTECTED_HEADS,
  PROTECTED_SUBHEADS,
  PROTECTED_FIELDS,
  PROTECTED_CLEARANCE,
  PROTECTED_MARK,
  isProtected,
  protectedNotice,
  ROLE_CLEARANCE,
  clearanceOf,
  filterRows,
  filterText,
  guardAnswer,
  describe,
};
