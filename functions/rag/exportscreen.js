'use strict';

/**
 * Export sensitivity screen — a checkpoint at the exit.
 *
 * THE GAP THIS CLOSES
 *
 * Sentinel's clearance controls are careful about who may SEE what: fields are
 * stripped before retrieval, coordinates coarsened, citations filtered, and a
 * protected identity needs break-glass. All of that governs the screen.
 *
 * Then an officer opens Report Studio, assembles a document out of twelve
 * things they were each individually cleared to read, presses Download, and a
 * PDF lands in their downloads folder. From there it is on WhatsApp.
 *
 * Every single read was authorised. The AGGREGATE never was. Nothing in the
 * system has ever looked at the finished document and asked whether this
 * particular pile of authorised facts should leave the building in one file.
 * That is what this module does.
 *
 * WHAT IT IS, AND WHAT IT IS NOT
 *
 * It is a speed bump, not a wall. Someone who means to leak can paraphrase
 * around any word list, and no screen here would stop them — they could also
 * simply photograph the monitor. What this reliably catches is the ACCIDENT:
 * the officer who did not notice their report names a protected witness, or
 * who exports forty phone numbers without ever thinking of it as a
 * personal-data export. That is the shape most real incidents take, and it is
 * worth catching. It must never be described as insider-threat protection.
 *
 * WHY DETERMINISTIC RULES AND NOT A MODEL
 *
 * Asking an LLM "is this sensitive?" fails three ways that matter for a
 * control: it answers differently on Tuesday, it can be argued out of its
 * judgement by the document's own text (the document is attacker-controlled
 * input here), and it cannot tell a supervisor precisely why it fired. A
 * keyword rule is testable, reviewable, reproducible, and shows its work. A
 * control has to be boring.
 *
 * WHY THE RULES ARE NARROWER THAN THEY LOOK
 *
 * The obvious rule set — informant, witness, caste, minor — is wrong here, and
 * measurably so. Sentinel's own CCTNS templates print those words as ordinary
 * field labels on the BLANK forms:
 *
 *     FIR                 →  "6. Complainant / Informant"
 *     Arrest Report       →  "(ix) Caste / Tribe"
 *     Charge Sheet        →  "13. Particulars of witnesses to be examined"
 *     Missing Person      →  "Informant — Name & mobile number"
 *
 * A screen built on the bare words flags every FIR, every arrest report and
 * every charge sheet ever exported. Supervisors would face dozens of approvals
 * a day, start clicking Approve without reading, and the control would become
 * theatre — worse than no control, because it manufactures the appearance of
 * oversight. So each rule below fires only on a QUALIFIER that distinguishes
 * the sensitive use from the routine one: not "informant" but "confidential
 * informant"; not "caste" but "caste atrocity". exportscreen.test.js pins the
 * blank templates as clean, so a future widening of a term list that would
 * re-flag them fails the suite instead of quietly killing the feature.
 *
 * THE DENSITY RULE
 *
 * The most damaging export is often the most boring-looking. A list of forty
 * accused with their phone numbers contains no alarming word anywhere, and no
 * category rule will ever fire on it. Counting distinct personal identifiers
 * catches it, because at some volume a case report has stopped being a case
 * report and become a contact list.
 */

const crypto = require('crypto');

// Distinct personal identifiers above which a document is bulk personal data
// rather than a case record. Five is low enough to catch a genuine roster and
// high enough that a normal FIR — complainant, accused, one or two witnesses —
// never reaches it.
const PHONE_LIMIT = 5;
const AADHAAR_LIMIT = 3;

/**
 * Category rules.
 *
 *   latin  — matched on WORD BOUNDARIES, case-insensitive. A bare substring
 *            match would fire "rape" inside "draped" and "grape". Multi-word
 *            entries tolerate any run of whitespace, so a phrase survives the
 *            line wrapping that HTML-to-text extraction introduces.
 *   native — matched as plain substrings. Kannada and Devanagari are
 *            agglutinative and \b is defined over ASCII word characters only,
 *            so a boundary match would silently never fire on them.
 *
 * The native lists are deliberately shorter than the Latin ones and hold only
 * unambiguous terms. A false positive in a script the reviewing supervisor
 * has to stop and parse costs more attention than it saves.
 */
const RULES = [
  {
    id: 'sexual-offence',
    label: 'Sexual offence / POCSO',
    why: 'Victim identity in a sexual-offence case is protected by law; publication is itself an offence.',
    latin: [
      'pocso', 'rape', 'gang rape', 'sexual assault', 'sexual offence', 'sexual offense',
      'sexual harassment', 'outraging modesty', 'outrage of modesty', 'molestation',
      'section 376', 'section 354',
    ],
    native: ['ಅತ್ಯಾಚಾರ', 'ಲೈಂಗಿಕ ದೌರ್ಜನ್ಯ', 'ಲೈಂಗಿಕ ಕಿರುಕುಳ'],
  },
  {
    id: 'minor',
    label: 'Minor / juvenile',
    // "minor" alone is far too common — "minor injuries", "a minor delay" — and
    // "juvenile" alone is a routine classification field. Both need the noun
    // that makes them about a specific child.
    latin: [
      'minor victim', 'child victim', 'minor girl', 'minor boy', 'underage victim',
      'juvenile in conflict with law', 'child in need of care', 'juvenile victim',
      'child sexual', 'child abuse', 'juvenile justice act',
    ],
    why: 'A child’s identity may not leave the case file; the Juvenile Justice Act bars disclosure.',
    native: ['ಅಪ್ರಾಪ್ತ ವಯಸ್ಕ', 'ಮಕ್ಕಳ ಮೇಲಿನ ದೌರ್ಜನ್ಯ'],
  },
  {
    id: 'caste-communal',
    label: 'Caste atrocity / communal',
    // NOT bare "caste" — "(ix) Caste / Tribe" is a printed field on the blank
    // Arrest Report, and flagging it would flag every arrest ever exported.
    latin: [
      'caste atrocity', 'caste violence', 'atrocities act', 'sc/st act', 'scst act',
      'prevention of atrocities', 'communal riot', 'communal tension', 'communal violence',
      'hate crime', 'religious tension',
    ],
    why: 'Caste and communal matters carry a statutory confidentiality and a real risk of retaliation.',
    native: ['ಜಾತಿ ದೌರ್ಜನ್ಯ', 'ಕೋಮು ಗಲಭೆ'],
  },
  {
    id: 'protected-source',
    label: 'Protected witness / confidential source',
    // NOT bare "informant" or "witness" — "Complainant / Informant" and
    // "Particulars of witnesses" are printed labels on FIR, Charge Sheet,
    // Missing Person and Seizure forms. Only the protective qualifiers fire.
    latin: [
      'protected witness', 'witness protection', 'confidential informant',
      'secret informant', 'identity of the informant', 'informant identity',
      'source identity', 'anonymous tip-off', 'identity must not be disclosed',
      'covert source',
    ],
    why: 'Naming a protected source outside the case file puts a person in physical danger.',
    native: ['ರಹಸ್ಯ ಸಾಕ್ಷಿ', 'ಸಾಕ್ಷಿ ಸಂರಕ್ಷಣೆ'],
  },
  {
    id: 'national-security',
    label: 'National security / terror',
    latin: [
      'uapa', 'unlawful activities prevention', 'terrorism', 'terrorist', 'terror attack',
      'sedition', 'anti-national', 'explosive substances act', 'ied recovery', 'naxal',
      'left wing extremism',
    ],
    why: 'Security-classified material requires sign-off before it leaves the system.',
    native: ['ಭಯೋತ್ಪಾದನೆ', 'ದೇಶದ್ರೋಹ'],
  },
  {
    id: 'live-operation',
    label: 'Ongoing covert operation',
    latin: [
      'undercover', 'sting operation', 'decoy operation', 'surveillance target',
      'raid planned', 'planned raid', 'trap laid', 'operation is ongoing',
      'source under development',
    ],
    why: 'Exporting a live operation’s detail can burn the operation and its officers.',
    native: ['ಗುಪ್ತ ಕಾರ್ಯಾಚರಣೆ'],
  },
];

// ── Matching ────────────────────────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Cache the compiled expression per term. The rule set is fixed at module load,
// so this is built once per container rather than once per export.
const latinRe = new Map();
function termRegex(term) {
  let re = latinRe.get(term);
  if (!re) {
    // Internal whitespace becomes \s+ so "sexual   assault" and a phrase broken
    // across a line still match. Boundaries stop "rape" hitting "draped".
    const body = term.split(/\s+/).map(escapeRe).join('\\s+');
    re = new RegExp(`(?<![\\p{L}\\d])${body}(?![\\p{L}\\d])`, 'iu');
    latinRe.set(term, re);
  }
  return re;
}

/**
 * Strip HTML to the prose a reader would actually see.
 *
 * Screening raw markup is wrong in both directions: <style> blocks and class
 * names are not content (a stylesheet mentioning "background" is not evidence
 * of anything), and a phrase split by an inline tag — "sexual <b>assault</b>" —
 * reads as one phrase on the page but never matches in the source. Dropping
 * script/style wholesale and replacing every remaining tag with a space fixes
 * both: tags become word boundaries, so the extracted text matches what the
 * officer sees.
 */
function textFromHtml(html) {
  return String(html || '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Distinct Indian mobile numbers.
 *
 * The guards matter more than the pattern. Sentinel's own crime numbers are
 * 18 digits (144221107202500999) and would otherwise yield a "phone number"
 * from any 10-digit window inside them, so a bare \d{10} scan would flag every
 * report that lists a handful of cases. Requiring a non-digit on both sides
 * means only a standalone number counts.
 */
function phoneNumbers(text) {
  const out = new Set();
  const re = /(?<![\d-])(?:\+?91[\s-]?)?([6-9]\d{9})(?![\d-])/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

/** Distinct Aadhaar-shaped numbers (12 digits, optionally spaced 4-4-4). */
function aadhaarNumbers(text) {
  const out = new Set();
  const re = /(?<![\d-])([2-9]\d{3})[\s-]?(\d{4})[\s-]?(\d{4})(?![\d-])/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1] + m[2] + m[3]);
  return out;
}

/**
 * Screen one document.
 *
 * Returns the verdict AND the evidence for it, because a supervisor deciding
 * on a held export needs to see which rule fired and on what — "flagged" with
 * no reason is an instruction to rubber-stamp.
 */
function screen(input, opts = {}) {
  const text = opts.isHtml === false ? String(input || '') : textFromHtml(input);
  const reasons = [];

  for (const rule of RULES) {
    let hit = null;
    for (const term of rule.latin) {
      if (termRegex(term).test(text)) { hit = term; break; }
    }
    if (!hit) {
      for (const term of rule.native || []) {
        if (text.includes(term)) { hit = term; break; }
      }
    }
    if (hit) reasons.push({ category: rule.id, label: rule.label, why: rule.why, evidence: hit });
  }

  const phones = phoneNumbers(text);
  const aadhaar = aadhaarNumbers(text);
  if (phones.size >= PHONE_LIMIT) {
    reasons.push({
      category: 'bulk-personal-data',
      label: 'Bulk personal data',
      why: 'At this volume the document is a contact list rather than a case record.',
      evidence: `${phones.size} distinct phone numbers`,
    });
  }
  if (aadhaar.size >= AADHAAR_LIMIT) {
    reasons.push({
      category: 'bulk-personal-data',
      label: 'Bulk personal data',
      why: 'Aadhaar numbers are protected identifiers and may not be exported in bulk.',
      evidence: `${aadhaar.size} distinct Aadhaar-format numbers`,
    });
  }

  return {
    needsReview: reasons.length > 0,
    reasons,
    stats: { chars: text.length, phones: phones.size, aadhaar: aadhaar.size },
  };
}

/**
 * Content fingerprint, used to bind a supervisor's approval to the exact
 * document they approved.
 *
 * Without this the control has a hole wide enough to drive through: request
 * approval for an innocuous report, wait for the supervisor to approve it,
 * then send a different document with the same approval id. The hold stores
 * this hash and release requires it to match, so an approval authorises one
 * document and nothing else.
 */
function fingerprint(input, opts = {}) {
  const text = opts.isHtml === false ? String(input || '') : textFromHtml(input);
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** One-line summary for an audit detail field. */
const summarise = (verdict) =>
  verdict.needsReview
    ? verdict.reasons.map((r) => r.label).join(', ')
    : 'no sensitive content detected';

module.exports = { screen, fingerprint, textFromHtml, summarise, RULES, PHONE_LIMIT, AADHAAR_LIMIT };
