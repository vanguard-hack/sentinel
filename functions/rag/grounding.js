'use strict';

/**
 * Did the answer stay inside what was actually read?
 *
 * THE FAILURE THIS CATCHES
 *
 * Sentinel already builds citations from retrieval rather than from the
 * model's own claims, which is the right way round. But nothing checked the
 * other direction: that the identifiers appearing IN THE ANSWER are among the
 * ones actually retrieved.
 *
 * Asked for theft cases in Mysuru, the assistant reads three real FIRs and can
 * still write "there were four: …, …, …, and 202600247". The fourth does not
 * exist. Everything around it is correct, the citation panel below shows three
 * genuine records, and nothing looks wrong — so an officer goes looking for a
 * file that was never opened. On a police console that is the worst available
 * failure: not a blank screen, a plausible one.
 *
 * THE RULE
 *
 * Supported = anything the model could have READ:
 *
 *   • the records, passages and documents retrieved for this answer;
 *   • the officer's own question;
 *   • the recent conversation, since a follow-up legitimately refers back.
 *
 * An identifier in the answer that appears in none of those was not retrieved
 * and was not given — the model produced it. That is a strict definition and
 * deliberately so: it does not judge whether the answer is TRUE, only whether
 * its identifiers came from somewhere.
 *
 * WHY THE OFFICER'S OWN WORDS COUNT
 *
 * An officer asks about a crime number that does not exist. The assistant
 * correctly replies "no record found for 144221107202500999". A naive checker
 * flags that number as unsupported — nothing was retrieved to back it — and
 * puts a warning on an answer that was exactly right.
 *
 * Get that wrong and officers learn to ignore the warning strip. Then it is
 * useless on the day it catches a real invention, which is the only day it
 * matters. So the question's own identifiers are supported by definition.
 *
 * WHAT IS DELIBERATELY NOT CHECKED
 *
 * Bare small integers. Record ids like CaseMasterID 42 are indistinguishable
 * from any other number in prose ("42 cases were registered"), so treating
 * them as identifiers would flag arithmetic as invention. Only formats that
 * are unmistakably identifiers are matched — see PATTERNS.
 *
 * This is a spell-check for invented record numbers, not a fact-checker. It
 * proves an identifier was seen; it cannot prove a sentence is true.
 */

const legal = require('./legal');

/**
 * Identifier shapes in this deployment's data.
 *
 * CRIME_NO   18 digits, e.g. 144221107202500001 — the CCTNS crime number.
 * CASE_NO    9 digits beginning with a year, e.g. 202500001.
 * FIR_SLASH  "FIR 123/2025" style. This deployment stores NO identifier in
 *            that form, so one in an answer is always the model reaching for a
 *            format it knows from elsewhere. It is matched only behind an
 *            explicit cue word: bare "12/2025" is far more often a date, and
 *            flagging dates is exactly the crying-wolf failure above.
 * PROP_REF   PROP-2026-00001, and the report/diary references Sentinel mints.
 */
const PATTERNS = [
  { kind: 'crime_number', re: /\b\d{18}\b/g },
  { kind: 'case_number', re: /\b(?:19|20)\d{7}\b/g },
  { kind: 'fir_number', re: /\b(?:FIR|crime|case)\s*(?:no\.?|number|#)?\s*(\d{1,5}\/(?:19|20)\d{2})\b/gi, group: 1 },
  { kind: 'reference', re: /\b(?:PROP|RPT|DIARY|EVD)-\d{4}-\d{3,6}\b/gi },
];

/** Act-qualified legal citations: "IPC 302", "under NDPS 20", "Section 66D of the IT Act". */
// The trailing guard is (?!\w) rather than \b: after a subsection like
// "303(2)" the next character is punctuation and so is the ")" before it, so
// \b never matches there — the group was silently dropped and "BNS 303(2)"
// came back as "303", which the reference then failed to recognise.
const SECTION_RE = /\b(IPC|BNS|NDPS|ARMS|IT|POCSO|MV|EXCISE|DP|KPA)\s*(?:act)?\s*(?:section|sec\.?|s\.|u\/s)?\s*(\d+[A-Z]{0,2}(?:\(\d+\))?)(?!\w)/gi;

/** "The records hold nothing on this" — said when something WAS retrieved. */
const DENIAL_RE =
  /\b(?:no|not any|zero)\s+(?:such\s+)?(?:matching\s+)?(?:records?|cases?|firs?|results?|entries|data)\b|\bnothing (?:was )?(?:found|matched|retrieved)\b|\bcould not find any\b|\bdoes not (?:hold|contain) any\b/i;

const norm = (v) => String(v == null ? '' : v).toUpperCase().replace(/\s+/g, '');

/** Every identifier-shaped token in a piece of text, as {value, kind}. */
function extract(text) {
  const out = [];
  const s = String(text || '');
  for (const p of PATTERNS) {
    for (const m of s.matchAll(p.re)) {
      const value = p.group ? m[p.group] : m[0];
      if (value) out.push({ value: String(value).trim(), kind: p.kind });
    }
  }
  return out;
}

/** Act-qualified section citations, as {act, section}. */
function extractSections(text) {
  const out = [];
  for (const m of String(text || '').matchAll(SECTION_RE)) {
    out.push({ act: legal.normAct(m[1]), section: legal.normSection(m[2]), raw: m[0].trim() });
  }
  return out;
}

/**
 * Collects everything the model was given, across whichever lanes ran.
 *
 * Lanes retrieve very different things — ZCQL rows, knowledge-base passages,
 * digitised scans, an OCR'd attachment — so the collector takes anything and
 * flattens it to text. Feeding it more than was strictly shown to the model is
 * safe (it can only reduce false alarms); feeding it less is not, which is why
 * `add` is called with the FULL row set rather than the truncated sample that
 * goes into a citation.
 */
function collector() {
  const parts = [];
  let rows = 0;
  return {
    /** Rows, strings, or nested objects — anything a lane retrieved. */
    add(value, rowCount) {
      if (value === null || value === undefined) return;
      if (typeof value === 'string') parts.push(value);
      else {
        try { parts.push(JSON.stringify(value)); } catch { /* unserialisable: skip */ }
      }
      if (Number.isFinite(rowCount)) rows += rowCount;
      else if (Array.isArray(value)) rows += value.length;
    },
    get rowCount() { return rows; },
    get retrieved() { return parts.length > 0; },
    text() { return parts.join('\n'); },
  };
}

/**
 * The set of identifiers the answer is allowed to contain.
 *
 * Normalised so that formatting differences — a stray space, a lowercase
 * prefix — do not turn a supported identifier into a phantom one.
 */
function supportedTokens({ evidence, question, history } = {}) {
  const set = new Set();
  const feed = (text) => extract(text).forEach((t) => set.add(norm(t.value)));

  // Seeded first, so they hold even when retrieval returned nothing at all —
  // which is exactly the "no record found for X" case.
  feed(question || '');
  for (const turn of Array.isArray(history) ? history : []) {
    feed(typeof turn === 'string' ? turn : (turn && turn.content) || '');
  }
  if (evidence) feed(typeof evidence === 'string' ? evidence : evidence.text());
  return set;
}

/**
 * Check one answer.
 *
 * Returns `checked: false` when there is nothing to say — no identifiers and
 * no denial — so a caller never has to distinguish "verified clean" from "not
 * applicable" by inspecting empty arrays.
 */
function check(answer, { evidence, question, history } = {}) {
  const text = String(answer || '');
  const supported = supportedTokens({ evidence, question, history });

  const seen = new Map();
  for (const t of extract(text)) {
    const key = norm(t.value);
    if (!supported.has(key) && !seen.has(key)) seen.set(key, { value: t.value, kind: t.kind });
  }

  // Legal citations are checked against the reference rather than against
  // retrieval: published law is not a record, and the KB is the authority for
  // which sections this deployment can speak to. A section outside it is the
  // model answering from its own memory — the thing lookup_law forbids.
  const evidenceText = evidence ? (typeof evidence === 'string' ? evidence : evidence.text()) : '';
  const bnsKnown = new Set(
    legal.SECTIONS.map((e) => e.bns_equivalent).filter(Boolean).map((v) => legal.normSection(v))
  );
  for (const c of extractSections(text)) {
    if (!c.act || !c.section) continue;
    // An officer citing "BNS 303" without the subsection is not inventing
    // anything, so a bare section number counts as known when the reference
    // holds any subsection of it.
    const known = c.act === 'BNS'
      ? bnsKnown.has(c.section) || [...bnsKnown].some((v) => v.startsWith(`${c.section}(`))
      : !!legal.SECTIONS.find((e) => e.act === c.act && legal.normSection(e.section) === c.section);
    // A section quoted straight out of a retrieved record is supported even if
    // the reference does not carry it: the data said so, not the model.
    if (known || evidenceText.includes(c.section)) continue;
    const key = `SEC:${c.act}:${c.section}`;
    if (!seen.has(key)) seen.set(key, { value: `${c.act} ${c.section}`, kind: 'legal_section' });
  }

  // The opposite failure: records were read and the answer denies they exist.
  // Only meaningful when something actually came back.
  const contradiction = !!(evidence && evidence.rowCount > 0 && DENIAL_RE.test(text));

  const unsupported = [...seen.values()].slice(0, 10);
  return {
    checked: unsupported.length > 0 || contradiction,
    grounded: unsupported.length === 0 && !contradiction,
    unsupported,
    contradiction,
    retrieved_rows: evidence ? evidence.rowCount : 0,
  };
}

/** One sentence for the officer, naming what to distrust and why. */
function warning(result) {
  if (!result || result.grounded) return null;
  const parts = [];
  if (result.unsupported.length) {
    const ids = result.unsupported.filter((u) => u.kind !== 'legal_section');
    const secs = result.unsupported.filter((u) => u.kind === 'legal_section');
    if (ids.length) {
      parts.push(
        `${ids.map((u) => u.value).join(', ')} ${ids.length === 1 ? 'does' : 'do'} not appear in any record retrieved for this answer — treat ${ids.length === 1 ? 'it' : 'them'} as unverified.`
      );
    }
    if (secs.length) {
      parts.push(
        `${secs.map((u) => u.value).join(', ')} ${secs.length === 1 ? 'is' : 'are'} outside Sentinel's legal reference — check the bare Act before relying on ${secs.length === 1 ? 'it' : 'them'}.`
      );
    }
  }
  if (result.contradiction) {
    parts.push(
      `This answer reports nothing on file, but ${result.retrieved_rows} record${result.retrieved_rows === 1 ? ' was' : 's were'} retrieved — open the sources below before accepting it.`
    );
  }
  return parts.join(' ');
}

module.exports = {
  PATTERNS, SECTION_RE, DENIAL_RE,
  extract, extractSections, collector, supportedTokens, check, warning,
};
