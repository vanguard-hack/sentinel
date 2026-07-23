// Custody & Corrections registry.
//
// Person-centric view over the FIR data: every distinct offender (global
// Accused.PersonID) becomes a custodial record, aggregating their cases,
// charges, arrests and case statuses. Correctional-specific facts that the FIR
// dataset does not carry — facility, bail history, sentence/remission, parole,
// reporting obligations — are DETERMINISTICALLY synthesised (mulberry32 PRNG
// seeded per person) so the registry is realistic and stable across reloads,
// consistent with the rest of the demo. Neutral legal terminology throughout.
import { runQuery } from './datastore';

const CAP = 300;
async function fetchAll(baseSql, table) {
  const out = [];
  for (let off = 0; off < 40000; off += CAP) {
    const rows = await runQuery(`${baseSql} LIMIT ${off}, ${CAP}`, table);
    out.push(...rows);
    if (rows.length < CAP) break;
  }
  return out;
}

// ── deterministic synthesis ────────────────────────────────────────────────
const djb2 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h >>> 0; };
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const RS = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const DAY = 86_400_000;
const NOW = Date.now();
const ts = (s) => { const t = Date.parse(String(s).slice(0, 10)); return Number.isFinite(t) ? t : NaN; };

export function fmtDate(d) {
  if (!d) return '—';
  const t = typeof d === 'number' ? d : ts(d);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
export const daysBetween = (a, b) => Math.max(0, Math.round((b - a) / DAY));

// Custody status catalogue (neutral legal terms) → chip colour class.
export const STATUS = {
  Undertrial: { label: 'Undertrial', cls: 'st-undertrial' },
  Convicted: { label: 'Convicted', cls: 'st-convicted' },
  'On bail': { label: 'On bail', cls: 'st-bail' },
  Released: { label: 'Released', cls: 'st-released' },
  Absconding: { label: 'Absconding', cls: 'st-absconding' },
};
export const STATUS_ORDER = ['Undertrial', 'Convicted', 'On bail', 'Released', 'Absconding'];

// Karnataka correctional facilities (central prisons + district prison fallback).
const CENTRAL = {
  'Bengaluru City': 'Parappana Agrahara Central Prison, Bengaluru',
  'Bengaluru Rural': 'Parappana Agrahara Central Prison, Bengaluru',
  Belagavi: 'Hindalga Central Prison, Belagavi',
  Mysuru: 'Central Prison, Mysuru',
  Kalaburagi: 'Central Prison, Kalaburagi',
  Ballari: 'Central Prison, Ballari',
  Dharwad: 'Central Prison, Dharwad',
  Vijayapura: 'Central Prison, Vijayapura',
  Shivamogga: 'Central Prison, Shivamogga',
  Tumakuru: 'Central Prison, Tumakuru',
};
const facilityFor = (district) => CENTRAL[district] || `District Prison, ${district || 'Karnataka'}`;
const facilityCapacity = (name) => {
  const r = mulberry32(djb2(name));
  return /Central/.test(name) ? RS(r, 900, 1800) : RS(r, 180, 520);
};

// Crime head → representative BNS (Bharatiya Nyaya Sanhita) sections charged.
const BNS = {
  body: [['103', 'Murder'], ['105', 'Culpable homicide'], ['115', 'Voluntarily causing hurt'], ['117', 'Grievous hurt'], ['109', 'Attempt to murder']],
  property: [['303', 'Theft'], ['305', 'Theft in dwelling'], ['309', 'Robbery'], ['310', 'Dacoity'], ['316', 'Criminal breach of trust'], ['318', 'Cheating']],
  women: [['64', 'Rape'], ['74', 'Assault on a woman'], ['85', 'Cruelty by husband/relatives'], ['79', 'Insulting modesty']],
  children: [['137', 'Kidnapping of a minor'], ['139', 'Exploitation of a child'], ['POCSO 6', 'Aggravated penetrative assault']],
  economic: [['316', 'Criminal breach of trust'], ['318', 'Cheating'], ['336', 'Forgery'], ['338', 'Forgery of valuable security']],
  cyber: [['319', 'Cheating by personation'], ['IT 66C', 'Identity theft'], ['IT 66D', 'Cheating by personation using computer']],
  narcotics: [['NDPS 20', 'Cannabis'], ['NDPS 21', 'Manufactured drugs'], ['NDPS 22', 'Psychotropic substances']],
  order: [['189', 'Unlawful assembly'], ['191', 'Rioting'], ['196', 'Promoting enmity']],
  traffic: [['MV 184', 'Dangerous driving'], ['BNS 281', 'Rash driving'], ['MV 185', 'Drunken driving']],
  other: [['351', 'Criminal intimidation'], ['329', 'Criminal trespass'], ['324', 'Mischief']],
};
function sectionSet(head, r) {
  const h = String(head).toLowerCase();
  const key = /body/.test(h) ? 'body' : /propert/.test(h) ? 'property' : /women/.test(h) ? 'women'
    : /child/.test(h) ? 'children' : /econom/.test(h) ? 'economic' : /cyber/.test(h) ? 'cyber'
    : /narco/.test(h) ? 'narcotics' : /order/.test(h) ? 'order' : /traffic/.test(h) ? 'traffic' : 'other';
  const pool = BNS[key];
  const n = RS(r, 1, Math.min(3, pool.length));
  const idxs = new Set();
  while (idxs.size < n) idxs.add(RS(r, 0, pool.length - 1));
  return [...idxs].map((i) => ({ code: `BNS ${pool[i][0]}`.replace('BNS NDPS', 'NDPS').replace('BNS IT', 'IT Act').replace('BNS MV', 'MV Act').replace('BNS POCSO', 'POCSO'), desc: pool[i][1] }));
}

const TRIAL_STAGES = ['Framing of charges', 'Prosecution evidence', 'Defence evidence', 'Final arguments', 'Judgment reserved'];
const BAIL_CONDITIONS = [
  'Surrender passport', 'Report weekly to the IO', 'Do not contact witnesses',
  'Remain within jurisdiction', 'Furnish two local sureties', 'Do not tamper with evidence',
];
const FIRST_ALIAS = ['Babu', 'Anna', 'Chikka', 'Dodda', 'Kariya', 'Guru', 'Raja', 'Chotu'];

export async function fetchCustodyData() {
  const [caseRows, accusedRows, arrestRows, unitRows, districtRows, courtRows, headRows, subRows, statusRows] =
    await Promise.all([
      fetchAll('SELECT CaseMasterID, CrimeNo, CrimeRegisteredDate, IncidentFromDate, PoliceStationID, CrimeMajorHeadID, CrimeMinorHeadID, CaseStatusID, GravityOffenceID, CourtID FROM CaseMaster', 'CaseMaster'),
      fetchAll('SELECT AccusedMasterID, CaseMasterID, PersonID, AccusedName, AgeYear, GenderID FROM Accused', 'Accused'),
      fetchAll('SELECT CaseMasterID, AccusedMasterID, ArrestSurrenderTypeID, ArrestSurrenderDate FROM ArrestSurrender', 'ArrestSurrender'),
      fetchAll('SELECT UnitID, UnitName, DistrictID FROM Unit', 'Unit'),
      fetchAll('SELECT DistrictID, DistrictName FROM District', 'District'),
      fetchAll('SELECT CourtID, CourtName FROM Court', 'Court'),
      fetchAll('SELECT CrimeHeadID, CrimeGroupName FROM CrimeHead', 'CrimeHead'),
      fetchAll('SELECT CrimeSubHeadID, CrimeHeadName FROM CrimeSubHead', 'CrimeSubHead'),
      fetchAll('SELECT CaseStatusID, CaseStatusName FROM CaseStatusMaster', 'CaseStatusMaster'),
    ]);
  return { caseRows, accusedRows, arrestRows, unitRows, districtRows, courtRows, headRows, subRows, statusRows };
}

// Compute the person records from FIR data + deterministic synthesis. This is
// the seed source and the fallback when nothing is persisted yet.
export function buildPeople(raw) {
  const unit = new Map(raw.unitRows.map((u) => [String(u.UnitID), u]));
  const district = new Map(raw.districtRows.map((d) => [String(d.DistrictID), d.DistrictName]));
  const court = new Map(raw.courtRows.map((c) => [String(c.CourtID), c.CourtName]));
  const head = new Map(raw.headRows.map((h) => [String(h.CrimeHeadID), h.CrimeGroupName]));
  const sub = new Map(raw.subRows.map((s) => [String(s.CrimeSubHeadID), s.CrimeHeadName]));
  const statusName = new Map(raw.statusRows.map((s) => [String(s.CaseStatusID), s.CaseStatusName]));

  const caseById = new Map();
  raw.caseRows.forEach((c) => {
    const u = unit.get(String(c.PoliceStationID));
    const dist = u ? district.get(String(u.DistrictID)) : '';
    caseById.set(String(c.CaseMasterID), {
      id: String(c.CaseMasterID),
      crimeNo: c.CrimeNo || '',
      date: String(c.IncidentFromDate || c.CrimeRegisteredDate || '').slice(0, 10),
      head: head.get(String(c.CrimeMajorHeadID)) || '—',
      subHead: sub.get(String(c.CrimeMinorHeadID)) || '—',
      station: (u?.UnitName || '—').replace(' Police Station', ''),
      district: dist || '—',
      court: court.get(String(c.CourtID)) || '—',
      statusId: String(c.CaseStatusID),
      status: statusName.get(String(c.CaseStatusID)) || '—',
      heinous: String(c.GravityOffenceID) === '1',
    });
  });

  // Arrest date per (accused-in-case).
  const arrestByAcc = new Map();
  raw.arrestRows.forEach((a) => {
    const k = String(a.AccusedMasterID);
    const t = ts(a.ArrestSurrenderDate);
    if (Number.isFinite(t) && (!arrestByAcc.has(k) || t < arrestByAcc.get(k))) arrestByAcc.set(k, t);
  });

  // Group Accused rows by global PersonID.
  const byPerson = new Map();
  raw.accusedRows.forEach((a) => {
    const pid = String(a.PersonID || '').trim();
    if (!pid) return;
    if (!byPerson.has(pid)) byPerson.set(pid, []);
    byPerson.get(pid).push(a);
  });

  const people = [];
  byPerson.forEach((rows, pid) => {
    const r = mulberry32(djb2('cust' + pid));
    const names = rows.map((x) => x.AccusedName).filter(Boolean);
    const name = names.sort((a, b) => names.filter((n) => n === b).length - names.filter((n) => n === a).length)[0] || 'Unknown';
    const age = Math.round(rows.reduce((s, x) => s + (Number(x.AgeYear) || 30), 0) / rows.length) || 30;
    const gender = ({ 1: 'Male', 2: 'Female', 3: 'Transgender' })[String(rows[0].GenderID)] || 'Male';

    const cases = [...new Map(rows.map((x) => {
      const c = caseById.get(String(x.CaseMasterID));
      const arrest = arrestByAcc.get(String(x.AccusedMasterID));
      return [String(x.CaseMasterID), c ? { ...c, arrestTs: arrest, sections: sectionSet(c.head, mulberry32(djb2(c.id + c.head))) } : null];
    })).values()].filter(Boolean).sort((a, b) => (ts(b.date) || 0) - (ts(a.date) || 0));
    if (!cases.length) return;

    const primary = cases[0];
    const arrestTs = cases.map((c) => c.arrestTs).filter(Number.isFinite).sort((a, b) => a - b)[0] || null;
    const anyArrest = arrestTs != null;
    const convictedCase = cases.find((c) => c.statusId === '4');
    const openCase = cases.find((c) => ['1', '2', '3'].includes(c.statusId));
    const priorConvictions = cases.filter((c) => c.statusId === '4').length;

    // ── custody status + sentence ───────────────────────────────────────
    let status;
    let sentence = null;
    let facility = null;
    let releaseDate = null;
    let custodyStart = arrestTs || ts(primary.date);

    if (convictedCase) {
      const convTs = (convictedCase.arrestTs || ts(convictedCase.date)) + RS(r, 200, 900) * DAY;
      const termMonths = convictedCase.heinous ? RS(r, 84, 300) : RS(r, 12, 84);
      const remissionDays = RS(r, 0, Math.round(termMonths * 30 * 0.25));
      const expectedRelease = convTs + termMonths * 30 * DAY - remissionDays * DAY;
      sentence = { convictionDate: convTs, termMonths, remissionDays, expectedRelease };
      custodyStart = convictedCase.arrestTs || convTs;
      if (expectedRelease <= NOW) { status = 'Released'; releaseDate = expectedRelease; }
      else { status = 'Convicted'; facility = facilityFor((convictedCase.district !== '—' ? convictedCase : primary).district); }
    } else if (openCase && anyArrest) {
      status = r() < 0.62 ? 'Undertrial' : 'On bail';
      if (status === 'Undertrial') facility = facilityFor(primary.district);
      else releaseDate = arrestTs + RS(r, 20, 180) * DAY;
    } else if (openCase && !anyArrest) {
      status = r() < 0.35 ? 'Absconding' : 'Undertrial';
      if (status === 'Undertrial') { custodyStart = ts(primary.date) + RS(r, 5, 60) * DAY; facility = facilityFor(primary.district); }
    } else {
      status = 'Released';
      releaseDate = (arrestTs || ts(primary.date)) + RS(r, 30, 400) * DAY;
      if (releaseDate > NOW) releaseDate = NOW - RS(r, 10, 200) * DAY;
    }

    const inCustody = status === 'Undertrial' || status === 'Convicted';
    const custodyDays = inCustody && Number.isFinite(custodyStart) ? daysBetween(custodyStart, NOW) : null;

    // ── case linkage / trial ────────────────────────────────────────────
    const trialStage = openCase ? pick(r, TRIAL_STAGES) : null;
    const nextHearing = openCase ? NOW + RS(r, 3, 75) * DAY : null;

    // ── custody timeline (audit trail) ──────────────────────────────────
    const timeline = [];
    if (arrestTs) timeline.push({ ts: arrestTs, label: `Arrested — ${primary.crimeNo}`, kind: 'arrest' });
    else timeline.push({ ts: ts(primary.date), label: `Case registered — ${primary.crimeNo}`, kind: 'case' });
    const remands = RS(r, 1, 4);
    let cursor = (arrestTs || ts(primary.date)) + RS(r, 10, 16) * DAY;
    for (let i = 0; i < remands && cursor < NOW; i++) {
      timeline.push({ ts: cursor, label: `Judicial remand extended (${(i + 1) * 14} days)`, kind: 'remand' });
      cursor += RS(r, 12, 20) * DAY;
    }
    if (inCustody && r() < 0.35) timeline.push({ ts: cursor + RS(r, 5, 40) * DAY, label: `Transferred to ${facility}`, kind: 'transfer' });
    if (sentence) timeline.push({ ts: sentence.convictionDate, label: `Convicted — ${sentence.termMonths} months`, kind: 'conviction' });
    if (releaseDate) timeline.push({ ts: releaseDate, label: status === 'Released' ? 'Released from custody' : 'Released on bail', kind: 'release' });
    timeline.sort((a, b) => a.ts - b.ts);

    // ── bail history ────────────────────────────────────────────────────
    const bailApps = [];
    const nBail = status === 'Absconding' ? 0 : RS(r, 0, 3);
    let bt = (arrestTs || ts(primary.date)) + RS(r, 7, 30) * DAY;
    for (let i = 0; i < nBail; i++) {
      const granted = status === 'On bail' || status === 'Released' ? r() < 0.6 : r() < 0.3;
      bailApps.push({
        date: bt,
        court: primary.court,
        outcome: granted ? 'Granted' : 'Rejected',
        surety: granted ? `₹${(RS(r, 1, 10) * 25000).toLocaleString('en-IN')} + ${RS(r, 1, 2)} surety` : '—',
        conditions: granted ? [pick(r, BAIL_CONDITIONS), pick(r, BAIL_CONDITIONS)].filter((v, ix, ar) => ar.indexOf(v) === ix) : [],
      });
      bt += RS(r, 20, 120) * DAY;
    }
    const nextBailHearing = status === 'Undertrial' && r() < 0.5 ? NOW + RS(r, 2, 45) * DAY : null;

    // ── release & post-release ──────────────────────────────────────────
    let release = null;
    if (status === 'Released' || status === 'On bail') {
      const parole = [];
      const nP = RS(r, 0, 2);
      let pt = (releaseDate || NOW) - RS(r, 100, 500) * DAY;
      for (let i = 0; i < nP; i++) {
        const dur = RS(r, 7, 30);
        parole.push({ type: pick(r, ['Parole', 'Furlough', 'Emergency parole']), from: pt, to: pt + dur * DAY, reason: pick(r, ['Family illness', 'Death in family', 'Agricultural work', 'Marriage in family']) });
        pt += RS(r, 60, 300) * DAY;
      }
      const obligation = pick(r, ['Weekly at ' + primary.station + ' PS', 'Fortnightly at ' + primary.station + ' PS', 'Monthly at ' + primary.station + ' PS']);
      const missed = r() < 0.18;
      const nextReport = NOW + RS(r, -10, 20) * DAY;
      release = { releaseDate, parole, obligation, nextReport, missed };
    }

    const aliases = r() < 0.35 ? [`${pick(r, FIRST_ALIAS)} ${name.split(' ').slice(-1)[0]}`] : [];
    const dobYear = 2026 - age;

    people.push({
      personId: pid,
      name,
      aliases,
      biometricId: `KA-BIO-${(djb2(pid) % 900000 + 100000)}`,
      dob: `${dobYear}-${String(RS(r, 1, 12)).padStart(2, '0')}-${String(RS(r, 1, 28)).padStart(2, '0')}`,
      age,
      gender,
      address: `${pick(r, ['1st', '2nd', '3rd', '4th'])} Cross, ${primary.station}, ${primary.district}`,
      status,
      facility,
      cases,
      primary,
      sections: [...new Map(cases.flatMap((c) => c.sections).map((s) => [s.code, s])).values()],
      court: primary.court,
      trialStage,
      nextHearing,
      sentence,
      timeline,
      bail: { applications: bailApps, nextBailHearing },
      release,
      recidivism: { priorConvictions, caseCount: cases.length, repeatOffender: cases.length >= 2 },
      custodyStart,
      custodyDays,
    });
  });

  return people;
}

// Turn a people[] list (synthesised and/or persisted) into the full registry —
// recomputing custody duration, facilities, analytics and alerts so persisted
// records stay fresh as time passes.
export function finalize(people) {
  people.forEach((p) => {
    const inCustody = p.status === 'Undertrial' || p.status === 'Convicted';
    p.custodyDays = inCustody && Number.isFinite(p.custodyStart) ? daysBetween(p.custodyStart, NOW) : null;
  });
  people.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (b.custodyDays || 0) - (a.custodyDays || 0));

  // ── facilities (overcrowding) ──────────────────────────────────────────
  const facMap = new Map();
  people.forEach((p) => {
    if (!p.facility) return;
    if (!facMap.has(p.facility)) facMap.set(p.facility, { facility: p.facility, capacity: facilityCapacity(p.facility), occupancy: 0, undertrials: 0, convicts: 0 });
    const f = facMap.get(p.facility);
    f.occupancy += 1;
    if (p.status === 'Undertrial') f.undertrials += 1; else if (p.status === 'Convicted') f.convicts += 1;
  });
  const facilities = [...facMap.values()].map((f) => ({ ...f, pct: Math.round((f.occupancy / f.capacity) * 100) })).sort((a, b) => b.pct - a.pct);

  // ── analytics ───────────────────────────────────────────────────────────
  const statusCounts = STATUS_ORDER.map((s) => ({ label: s, value: people.filter((p) => p.status === s).length }));
  const undertrials = people.filter((p) => p.status === 'Undertrial').length;
  const convicts = people.filter((p) => p.status === 'Convicted').length;
  const inCustody = people.filter((p) => p.status === 'Undertrial' || p.status === 'Convicted');
  const avgCustodyDays = inCustody.length ? Math.round(inCustody.reduce((s, p) => s + (p.custodyDays || 0), 0) / inCustody.length) : 0;
  const analytics = {
    statusCounts,
    undertrials,
    convicts,
    ratio: convicts ? (undertrials / convicts) : undertrials,
    avgCustodyDays,
    facilities,
    total: people.length,
  };

  // ── alerts ────────────────────────────────────────────────────────────
  const within = (t, days) => Number.isFinite(t) && t >= NOW && t <= NOW + days * DAY;
  const alerts = {
    releases: people.filter((p) => p.status === 'Convicted' && p.sentence && within(p.sentence.expectedRelease, 90))
      .map((p) => ({ id: p.personId, name: p.name, date: p.sentence.expectedRelease, facility: p.facility }))
      .sort((a, b) => a.date - b.date),
    hearings: people.filter((p) => within(p.bail.nextBailHearing, 30))
      .map((p) => ({ id: p.personId, name: p.name, date: p.bail.nextBailHearing, court: p.court }))
      .sort((a, b) => a.date - b.date),
    missed: people.filter((p) => p.release && p.release.missed)
      .map((p) => ({ id: p.personId, name: p.name, obligation: p.release.obligation, status: p.status }))
      .slice(0, 40),
  };

  const byId = new Map(people.map((p) => [p.personId, p]));
  return { people, byId, facilities, analytics, alerts, now: NOW };
}

// Back-compat: build the whole registry from FIR data alone (no persistence).
export function buildRegistry(raw) {
  return finalize(buildPeople(raw));
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json().catch(() => ({}));
}

// ── persistence: read persisted records, merge over the computed registry ───
// Module-level cache so the registry and a record detail share one fetch.
let _cache = null;
export async function getRegistry(force = false) {
  if (_cache && !force) return _cache;
  const synth = buildPeople(await fetchCustodyData());
  let overlays = [];
  let tableReady = false;
  try {
    const r = await post('/server/rag/custody/list', {});
    tableReady = r.persisted !== false;
    if (Array.isArray(r.records)) overlays = r.records;
  } catch { /* fall back to synthesis */ }

  // Persisted record (authoritative) overrides the synthesised one per person;
  // persons not yet persisted keep their synthesised record.
  const byId = new Map(synth.map((p) => [p.personId, p]));
  overlays.forEach((o) => { if (o && o.personId) byId.set(o.personId, o); });

  _cache = finalize([...byId.values()]);
  _cache.tableReady = tableReady;
  _cache.persistedCount = overlays.length;
  return _cache;
}

// Seed the Data Store from the computed registry (admin action). Sends batches;
// the backend inserts only persons not already present. Returns total seeded.
export async function seedCustody(onProgress) {
  const reg = await getRegistry();
  const people = reg.people;
  const B = 120;
  let seeded = 0;
  for (let i = 0; i < people.length; i += B) {
    const batch = people.slice(i, i + B);
    const r = await post('/server/rag/custody/seed', { records: batch });
    seeded += r.seeded || 0;
    if (onProgress) onProgress(Math.min(i + B, people.length), people.length, seeded);
  }
  _cache = null; // force a reload from the Data Store next time
  return seeded;
}

// Persist an edited record; updates the in-memory cache on success.
export async function saveCustodyRecord(person) {
  const r = await post('/server/rag/custody/save', { record: person });
  if (r && r.ok && _cache) {
    _cache.byId.set(person.personId, person);
    const i = _cache.people.findIndex((p) => p.personId === person.personId);
    if (i >= 0) _cache.people[i] = person;
  }
  return r && r.ok;
}

// Sections list joined for search/filter.
export const allSections = (people) =>
  [...new Set(people.flatMap((p) => p.sections.map((s) => s.code)))].sort();
export const allFacilities = (people) =>
  [...new Set(people.map((p) => p.facility).filter(Boolean))].sort();
