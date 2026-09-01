'use strict';

/**
 * Legal reference lookup.
 *
 * The assistant already ROUTED legal questions — SOP_RE matches "section 302"
 * and "under IPC" — and the knowledge-base tool described itself to the model
 * as "the QuickML legal/SOP corpus". But that corpus holds no law: all seven
 * documents are data dumps of FIRs, gangs, officers, stations and modus
 * operandi. Asked what section 302 is, the assistant had nothing to retrieve
 * and was correctly forbidden from answering out of general knowledge. This
 * module is the missing half.
 *
 * It is a LOOKUP, not a retrieval. "What is the punishment under 379" has one
 * right answer, and semantic search over prose is the wrong instrument for it:
 * a lookup table cannot return the neighbouring section because it embedded
 * similarly. Scope is the 35 sections that actually appear in this deployment's
 * Section.csv, so every entry is one an officer can meet on a charge sheet.
 *
 * PROVENANCE. The entries were drafted for this prototype, not transcribed from
 * the gazette and not reviewed by a law officer. Every record carries
 * verified:false and every answer carries the caveat — see disclaimer(). That
 * caveat is not decoration: an officer acting on a punishment or a bail
 * classification taken from here without checking it is the failure this file
 * has to avoid.
 */

const KB = require('./legal_kb.json');

const SECTIONS = KB.sections;
const META = KB._meta;

const DISCLAIMER =
  'Operational reference only, drafted for this prototype — not verified against '
  + 'the official gazette. Check the bare Act before relying on it in a charge sheet '
  + 'or a court document.';

const disclaimer = () => DISCLAIMER;

// "302", "IPC 302", "s.302", "section 498A", "u/s 66C" all mean the same thing
// to an officer, so normalise before matching rather than demanding a format.
const normSection = (s) =>
  String(s || '')
    .toUpperCase()
    .replace(/\bU\/S\b|\bSEC(TION)?\b|\bS\./g, ' ')
    .replace(/[^A-Z0-9()]/g, '')
    .trim();

const ACT_ALIASES = {
  IPC: 'IPC', INDIANPENALCODE: 'IPC', PENALCODE: 'IPC',
  BNS: 'BNS', BHARATIYANYAYASANHITA: 'BNS',
  NDPS: 'NDPS', ARMS: 'ARMS', ARMSACT: 'ARMS',
  IT: 'IT', ITACT: 'IT', INFORMATIONTECHNOLOGY: 'IT',
  POCSO: 'POCSO', MV: 'MV', MVACT: 'MV', MOTORVEHICLES: 'MV',
  EXCISE: 'EXCISE', DP: 'DP', DOWRY: 'DP', DOWRYPROHIBITION: 'DP',
  KPA: 'KPA', KP: 'KPA', KARNATAKAPOLICE: 'KPA',
};
const normAct = (a) => {
  const k = String(a || '').toUpperCase().replace(/[^A-Z]/g, '');
  return ACT_ALIASES[k] || (k || null);
};

/** One section, by act and number. Act is optional — IPC is the common case. */
function findSection(act, section) {
  const s = normSection(section);
  if (!s) return null;
  const a = normAct(act);
  const matches = SECTIONS.filter((e) => normSection(e.section) === s && (!a || e.act === a));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    // Same number in two acts (e.g. "20" is NDPS here) — say so rather than pick.
    return { ambiguous: matches.map((m) => ({ act: m.act, section: m.section, title: m.title })) };
  }
  return null;
}

/** Free-text search over title and summary, for "what covers cheating". */
function searchLaw(text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  return SECTIONS
    .map((e) => {
      const hay = `${e.act} ${e.section} ${e.title} ${e.summary}`.toLowerCase();
      const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0)
        + (e.title.toLowerCase().includes(q) ? 3 : 0);
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e);
}

/**
 * IPC -> BNS, and back.
 *
 * The direction that matters day to day is IPC -> BNS: officers know the old
 * numbering and charge sheets now cite the new. The reverse is needed when
 * reading a fresh FIR against older case law.
 *
 * A null bns_equivalent is an ANSWER, not a gap: the BNS replaced the Penal
 * Code only. NDPS, Arms, IT, POCSO, MV, Excise, Dowry Prohibition and the
 * Karnataka Police Act are untouched by it, and saying "no BNS equivalent"
 * without that reason invites an officer to think the record is incomplete.
 */
function mapToBns(section, act) {
  const hit = findSection(act || 'IPC', section);
  if (!hit) return { found: false };
  if (hit.ambiguous) return { found: false, ambiguous: hit.ambiguous };
  if (hit.act !== 'IPC') {
    return {
      found: true, act: hit.act, section: hit.section, title: hit.title,
      bns_equivalent: null,
      note: `${hit.act} is a special or local law. The Bharatiya Nyaya Sanhita replaced the Indian Penal Code only, so ${hit.act} ${hit.section} continues under its own numbering.`,
    };
  }
  return {
    found: true, act: 'IPC', section: hit.section, title: hit.title,
    bns_equivalent: hit.bns_equivalent,
    note: `IPC ${hit.section} (${hit.title}) corresponds to BNS ${hit.bns_equivalent}. ${META.cutoff}`,
  };
}

function mapFromBns(bnsSection) {
  const b = normSection(bnsSection);
  const hits = SECTIONS.filter((e) => e.bns_equivalent && normSection(e.bns_equivalent) === b);
  if (!hits.length) {
    return { found: false, note: `No IPC section in this reference maps to BNS ${bnsSection}. It covers the 35 sections used in this deployment's case data, not the whole Sanhita.` };
  }
  return {
    found: true, bns_section: bnsSection,
    ipc_equivalents: hits.map((h) => ({ act: h.act, section: h.section, title: h.title })),
    note: `${META.cutoff}`,
  };
}

/** Everything on the books for one act, for "what NDPS sections do we use". */
function listAct(act) {
  const a = normAct(act);
  const rows = SECTIONS.filter((e) => e.act === a);
  return { act: a, count: rows.length, sections: rows.map((e) => ({ section: e.section, title: e.title })) };
}

const acts = () => [...new Set(SECTIONS.map((e) => e.act))];

/** Present one entry with its caveat attached, never bare. */
function present(entry) {
  return {
    act: entry.act,
    section: entry.section,
    title: entry.title,
    summary: entry.summary,
    punishment: entry.punishment,
    cognizable: entry.cognizable,
    bailable: entry.bailable,
    triable_by: entry.triable_by,
    bns_equivalent: entry.bns_equivalent,
    ...(entry.bns_equivalent === null && entry.act !== 'BNS'
      ? { bns_note: `${entry.act} is a special or local law, unaffected by the BNS.` } : {}),
    ...(entry.notes ? { notes: entry.notes } : {}),
    verified: entry.verified === true,
    disclaimer: DISCLAIMER,
  };
}

module.exports = {
  SECTIONS, META, DISCLAIMER,
  disclaimer, findSection, searchLaw, mapToBns, mapFromBns, listAct, acts, present,
  normSection, normAct,
};
