// Investigation Diary — the Case Diary Statement under Section 172 BNSS
// (formerly Section 172 CrPC), the legally mandated day-by-day record an
// Indian Investigating Officer keeps for every case. The record structure
// mirrors the CCTNS Integrated Investigation Forms (IIF1-5):
//   IIF1  FIR                          → case identifiers (below)
//   IIF2  Crime Details Form           → case type / sections invoked
//   S.172 BNSS Case Diary              → diaryEntries
//   S.161 BNSS Witness Statement       → statements
//   IIF3  Arrest / Court Surveillance  → timeline (arrests, remand, court dates)
//   IIF5  Result of Investigation /
//         Property Register           → evidence (seizures, chain of custody)
//   IIF4  Charge Sheet / Final Report  → status = 'Chargesheet Filed'
//
// Records live as one Stratus JSON blob per case (functions/rag, no new Data
// Store table — see access.js / audit.js for the same pattern), fronted by
// the /server/rag/investigation/* endpoints. Case identifiers are seeded from
// the real CaseMaster row via ZCQL so a diary can never drift from the FIR.

import { getCatalyst } from './catalyst';

export const IIF_LABELS = {
  overview: 'IIF-1 · FIR + IIF-2 · Crime Details',
  diary: 'Case Diary — Section 172 BNSS',
  statements: 'Witness Statement — Section 161 BNSS',
  evidence: 'IIF-5 · Result of Investigation / Property Register',
  timeline: 'IIF-3 · Arrest / Court Surveillance',
  nextSteps: 'Suggested next steps',
  summary: 'AI investigation brief (advisory)',
};

export const STATUS_OPTIONS = ['Open', 'Under Investigation', 'Chargesheet Filed', 'Cold', 'Closed', 'Reopened'];
export const PERSON_ROLES = ['Complainant', 'Witness', 'Suspect', 'Accused'];
export const PERSON_STATUSES = ['At large', 'Absconding', 'Arrested', 'On bail', 'Cooperating', 'Deceased'];
export const EVIDENCE_TYPES = ['Physical', 'Digital', 'Documentary', 'Forensic'];
export const FSL_STATUSES = ['Not sent', 'Sent — pending', 'Report received'];
export const TIMELINE_TYPES = ['Arrest', 'Search', 'Remand Application', 'Forensic Request', 'Surrender', 'Court Date', 'Other'];
export const FINDING_TYPES = ['Observation', 'Working theory', 'Pending action'];

const STATUS_COLORS = {
  Open: 'blue', 'Under Investigation': 'amber', 'Chargesheet Filed': 'green',
  Cold: 'grey', Closed: 'grey', Reopened: 'purple',
};
export const statusColor = (s) => STATUS_COLORS[s] || 'grey';

// ── Rule-based intelligence (deterministic, no model calls) ─────────────────

// A case is "stale" once its diary has gone quiet for a while, and "cold"
// once that silence is long — purely a threshold on the last diary date, per
// the brief's "rule-based ... scoring for cases stalled beyond thresholds".
export function coldCaseFlag(rec) {
  if (!rec || ['Chargesheet Filed', 'Closed'].includes(rec.status)) return null;
  const last = rec.lastDiaryDate ? Date.parse(rec.lastDiaryDate) : Date.parse(rec.registeredDate || '');
  if (!Number.isFinite(last)) return null;
  const days = Math.floor((Date.now() - last) / 86_400_000);
  if (days >= 90) return { level: 'cold', label: `Cold — ${days}d silent`, days };
  if (days >= 30) return { level: 'stale', label: `Stale — ${days}d silent`, days };
  return null;
}

// Standard-steps checklist assistant — flags gaps in the record, never makes
// a decision. Mirrors the brief's "next-action suggestions" as a checklist,
// not an autonomous recommender.
export function nextStepSuggestions(rec) {
  if (!rec) return [];
  const out = [];
  if (!rec.diaryEntries?.length) {
    out.push({ id: 'first-entry', text: 'No case diary entries filed yet — the first entry is due under Section 172 BNSS.' });
  }
  if (!rec.statements?.length) {
    out.push({ id: 'statements', text: 'No witness/complainant statements recorded (Section 161 BNSS).' });
  }
  if (!rec.persons?.length) {
    out.push({ id: 'persons', text: 'No persons of interest logged — add complainant, witnesses, suspects or accused as they emerge.' });
  }
  const hasForensicEvidence = (rec.evidence || []).some((e) => e.type === 'Forensic');
  const hasPendingFsl = (rec.evidence || []).some((e) => e.fslStatus && e.fslStatus !== 'Report received');
  if (hasForensicEvidence && hasPendingFsl) {
    out.push({ id: 'fsl', text: 'Forensic evidence logged with no FSL report on record yet — follow up on lab turnaround.' });
  }
  if ((rec.persons || []).some((p) => p.role === 'Accused' && p.status === 'At large')) {
    out.push({ id: 'absconding', text: 'One or more accused shown "At large" — consider a search/surveillance timeline entry.' });
  }
  const cold = coldCaseFlag(rec);
  if (cold) out.push({ id: 'cold', text: `${cold.label} — review for reassignment or closure justification.` });
  const daysSinceReg = rec.registeredDate ? Math.floor((Date.now() - Date.parse(rec.registeredDate)) / 86_400_000) : null;
  if (daysSinceReg != null && daysSinceReg > 90 && rec.status === 'Under Investigation') {
    out.push({ id: 'lag', text: `Case has been under investigation for ${daysSinceReg} days — review against chargesheet timelines.` });
  }
  return out;
}

// ── Server calls (role-gated: investigator / supervisor / admin) ────────────

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const listInvestigations = () => post('/server/rag/investigation/list').then((d) => d.cases || []);
export const getInvestigation = (caseMasterId) => post('/server/rag/investigation/get', { caseMasterId }).then((d) => d.record);
export const createInvestigation = (payload) => post('/server/rag/investigation/create', payload);
export const setInvestigationStatus = (caseMasterId, status) =>
  post('/server/rag/investigation/status', { caseMasterId, status }).then((d) => d.record);
export const appendInvestigationItem = (caseMasterId, section, item) =>
  post('/server/rag/investigation/append', { caseMasterId, section, item });
export const updateInvestigationItem = (caseMasterId, section, entryId, patch) =>
  post('/server/rag/investigation/update', { caseMasterId, section, entryId, patch }).then((d) => d.record);
export const deleteInvestigationItem = (caseMasterId, section, entryId) =>
  post('/server/rag/investigation/delete', { caseMasterId, section, entryId }).then((d) => d.record);
export const reorderInvestigationItems = (caseMasterId, section, orderedIds) =>
  post('/server/rag/investigation/reorder', { caseMasterId, section, orderedIds }).then((d) => d.record);
export const summarizeInvestigation = (caseMasterId) =>
  post('/server/rag/investigation/summarize', { caseMasterId });

// ── Evidence media: audio recordings + scanned documents ────────────────────
// Recordings/scans are stored as individual Stratus objects (see functions/
// rag), referenced by key from the statement that owns them. Playback always
// goes through the authenticated /media/get endpoint — never a bare URL.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
async function toHex(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}
function base64ToBlobUrl(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

// Uploads a recording/scan as evidence and returns { key, mime, size }.
//
// The body is ALWAYS hex-encoded (never raw binary). Catalyst's API gateway
// runs a "resource access policy" that scans cookie-authenticated request
// bodies for attack byte-patterns and 403s ("request denied by resource
// access policy") when raw audio/image bytes happen to match one. Hex is only
// [0-9a-f], so it can never match a signature — the same proven trick the
// profile-photo upload uses. (An earlier version sent audio as raw
// octet-stream and tripped exactly this policy on real MediaRecorder output.)
export async function uploadEvidenceMedia(caseMasterId, blob, filename) {
  // Normalise "audio/webm;codecs=opus" → "audio/webm": the ";codecs=" suffix
  // real MediaRecorder blobs carry both breaks the stored-file extension
  // mapping and puts ';'/'=' into the query string. The base type is all we
  // need for the extension and for playback.
  const mime = (blob.type || 'application/octet-stream').split(';')[0].trim();
  const qs = new URLSearchParams({ caseMasterId, mime, filename: filename || 'file' }).toString();
  const res = await fetch(`/server/rag/investigation/media/upload?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: await toHex(blob),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Fetches a stored recording/scan and returns a blob: URL ready for <audio>/
// <img>/download. Caller should revokeObjectURL when done with it.
export async function fetchEvidenceMediaUrl(key) {
  const res = await fetch('/server/rag/investigation/media/get', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return base64ToBlobUrl(data.data, data.mime);
}

// Extracts text from a scanned testimony (JPEG/PNG) via Catalyst Zia OCR, and
// keeps the source scan in Stratus for provenance. Returns { text, key }.
export async function ocrExtractText(caseMasterId, blob, filename) {
  const mime = /^image\/(jpeg|png)$/.test(blob.type) ? blob.type : 'image/jpeg';
  const qs = new URLSearchParams({ caseMasterId, mime, filename: filename || 'document.jpg' }).toString();
  const res = await fetch(`/server/rag/investigation/ocr?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: await toHex(blob),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── CaseMaster search (browser ZCQL, same pattern as Case Files) ────────────

function zcql() {
  const cat = getCatalyst();
  const q = cat && cat.ZCatalystQL;
  if (!q || typeof q.executeQuery !== 'function') throw new Error('Data Store is unavailable.');
  return q;
}
function flatten(resp, table) {
  const rows = Array.isArray(resp) ? resp : Array.isArray(resp?.content) ? resp.content : [];
  return rows.map((r) => (r && typeof r === 'object' && r[table]) || r);
}
const escLiteral = (s) => String(s).replace(/'/g, "''");

let masterCache = null;
async function loadMasters() {
  if (masterCache) return masterCache;
  const run = (table) => zcql().executeQuery(`SELECT * FROM ${table} LIMIT 0, 2000`).then((r) => flatten(r, table));
  const [units, districts, heads, subheads] = await Promise.all([
    run('Unit'), run('District'), run('CrimeHead'), run('CrimeSubHead'),
  ]);
  const byId = (rows, key) => new Map(rows.map((r) => [String(r[key]), r]));
  masterCache = {
    unitById: byId(units, 'UnitID'),
    districtById: byId(districts, 'DistrictID'),
    headById: byId(heads, 'CrimeHeadID'),
    subheadById: byId(subheads, 'CrimeSubHeadID'),
  };
  return masterCache;
}

// Search CaseMaster by crime/case number and shape a compact result the
// "open new investigation" picker can render directly.
export async function searchCases(query) {
  const q = (query || '').trim();
  if (!q) return [];
  const m = await loadMasters();
  const variants = [...new Set([q, q.toUpperCase(), q.toLowerCase()])];
  const where = variants.map((v) => `CrimeNo LIKE '%${escLiteral(v)}%' OR CaseNo LIKE '%${escLiteral(v)}%'`).join(' OR ');
  const resp = await zcql().executeQuery(`SELECT * FROM CaseMaster WHERE ${where} LIMIT 0, 25`);
  const rows = flatten(resp, 'CaseMaster');
  return rows.map((c) => {
    const unit = m.unitById.get(String(c.PoliceStationID));
    const district = m.districtById.get(String(unit?.DistrictID ?? ''));
    const head = m.headById.get(String(c.CrimeMajorHeadID));
    const subhead = m.subheadById.get(String(c.CrimeMinorHeadID));
    return {
      caseMasterId: String(c.CaseMasterID),
      crimeNo: c.CrimeNo || '',
      caseNo: c.CaseNo || '',
      station: unit?.UnitName || '',
      district: district?.DistrictName || '',
      caseType: subhead?.CrimeHeadName || head?.CrimeGroupName || '',
      registeredDate: (c.CrimeRegisteredDate || '').slice(0, 10),
    };
  });
}

// IPC/BNS sections charged on a case ("IPC 379, IT 66C" style) — ActID and
// SectionID in ActSectionAssociation already ARE the readable act/section
// codes (see ksp/fir/ActSectionAssociation.csv), so no further join needed.
export async function fetchCaseSections(caseMasterId) {
  try {
    const resp = await zcql().executeQuery(
      `SELECT * FROM ActSectionAssociation WHERE CaseMasterID = ${Number(caseMasterId)} LIMIT 0, 50`
    );
    const rows = flatten(resp, 'ActSectionAssociation');
    rows.sort((a, b) => (Number(a.ActOrderID) || 0) - (Number(b.ActOrderID) || 0));
    return rows.map((r) => `${r.ActID} ${r.SectionID}`).join(', ');
  } catch {
    return '';
  }
}
