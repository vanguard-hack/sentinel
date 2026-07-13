// Latest FIRs with full enriched detail for the Incidents page. ZCQL has no
// joins here, so we fetch the newest N cases, then pull their related rows with
// WHERE CaseMasterID IN (...) and stitch everything together client-side using
// master-table lookups.
import { runQuery } from './datastore';

const GENDER = { 1: 'Male', 2: 'Female', 3: 'Transgender' };
const CATEGORY = { 1: 'FIR', 3: 'UDR', 4: 'PAR', 8: 'Zero FIR' };
const GRAVITY = { 1: 'Heinous', 2: 'Non-Heinous' };
const ARREST_TYPE = { 1: 'Arrest', 2: 'Surrender' };

// Deterministic, plausible contact number from an officer id (synthetic data).
function officerPhone(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const num = (9000000000 + (h % 999999999)).toString().slice(0, 10);
  return `+91 ${num.slice(0, 5)} ${num.slice(5)}`;
}

// ZCQL returns an EMPTY result for any single query whose row count exceeds
// ~300, so every read here is paged in ≤CAP chunks (see aianalytics PAGE too).
// `baseSql` must NOT carry its own LIMIT — we append it.
const CAP = 300;
async function fetchAll(baseSql, table) {
  const out = [];
  for (let off = 0; off < 20000; off += CAP) {
    const rows = await runQuery(`${baseSql} LIMIT ${off}, ${CAP}`, table);
    out.push(...rows);
    if (rows.length < CAP) break;
  }
  return out;
}

async function mapOf(table, idCol, cols) {
  const rows = await fetchAll(`SELECT ${[idCol, ...cols].join(', ')} FROM ${table}`, table);
  const m = new Map();
  rows.forEach((r) => m.set(String(r[idCol]), r));
  return m;
}

const inList = (ids) => ids.map((i) => `'${String(i).replace(/'/g, "''")}'`).join(', ');

export async function fetchIncidents(limit = 30) {
  const cases = await runQuery(
    'SELECT CaseMasterID, CrimeNo, CaseNo, CrimeRegisteredDate, PolicePersonID, PoliceStationID, ' +
      'CaseCategoryID, GravityOffenceID, CrimeMajorHeadID, CrimeMinorHeadID, CaseStatusID, CourtID, ' +
      'IncidentFromDate, IncidentToDate, InfoReceivedPSDate, latitude, longitude, BriefFacts ' +
      `FROM CaseMaster ORDER BY CrimeRegisteredDate DESC LIMIT 0, ${limit}`,
    'CaseMaster'
  );
  if (!cases.length) return [];
  const ids = cases.map((c) => c.CaseMasterID);
  const idIn = inList(ids);

  const [
    units, districts, employees, ranks, designations, heads, subheads, statuses,
    courts, occupations, religions, castes, acts, sections,
    complainants, victims, accused, arrests, actSecs, chargesheets,
  ] = await Promise.all([
    mapOf('Unit', 'UnitID', ['UnitName', 'DistrictID']),
    mapOf('District', 'DistrictID', ['DistrictName']),
    mapOf('Employee', 'EmployeeID', ['FirstName', 'RankID', 'DesignationID', 'UnitID', 'KGID']),
    mapOf('Rank', 'RankID', ['RankName']),
    mapOf('Designation', 'DesignationID', ['DesignationName']),
    mapOf('CrimeHead', 'CrimeHeadID', ['CrimeGroupName']),
    mapOf('CrimeSubHead', 'CrimeSubHeadID', ['CrimeHeadName']),
    mapOf('CaseStatusMaster', 'CaseStatusID', ['CaseStatusName']),
    mapOf('Court', 'CourtID', ['CourtName']),
    mapOf('OccupationMaster', 'OccupationID', ['OccupationName']),
    mapOf('ReligionMaster', 'ReligionID', ['ReligionName']),
    mapOf('CasteMaster', 'caste_master_id', ['caste_master_name']),
    mapOf('Act', 'ActCode', ['ShortName', 'ActDescription']),
    fetchAll('SELECT ActCode, SectionCode, SectionDescription FROM Section', 'Section'),
    fetchAll(`SELECT CaseMasterID, ComplainantName, AgeYear, OccupationID, ReligionID, CasteID, GenderID FROM ComplainantDetails WHERE CaseMasterID IN (${idIn})`, 'ComplainantDetails'),
    fetchAll(`SELECT CaseMasterID, VictimName, AgeYear, GenderID, VictimPolice FROM Victim WHERE CaseMasterID IN (${idIn})`, 'Victim'),
    fetchAll(`SELECT CaseMasterID, AccusedName, AgeYear, GenderID, PersonID FROM Accused WHERE CaseMasterID IN (${idIn})`, 'Accused'),
    fetchAll(`SELECT CaseMasterID, ArrestSurrenderTypeID, ArrestSurrenderDate, IOID FROM ArrestSurrender WHERE CaseMasterID IN (${idIn})`, 'ArrestSurrender'),
    fetchAll(`SELECT CaseMasterID, ActID, SectionID FROM ActSectionAssociation WHERE CaseMasterID IN (${idIn})`, 'ActSectionAssociation'),
    fetchAll(`SELECT CaseMasterID, csdate, cstype FROM ChargesheetDetails WHERE CaseMasterID IN (${idIn})`, 'ChargesheetDetails'),
  ]);

  const secMap = new Map();
  sections.forEach((s) => secMap.set(`${s.ActCode}|${s.SectionCode}`, s.SectionDescription));
  const groupBy = (rows) => {
    const m = new Map();
    rows.forEach((r) => { const k = String(r.CaseMasterID); (m.get(k) || m.set(k, []).get(k)).push(r); });
    return m;
  };
  const cById = groupBy(complainants);
  const vById = groupBy(victims);
  const aById = groupBy(accused);
  const arrById = groupBy(arrests);
  const asById = groupBy(actSecs);
  const csById = groupBy(chargesheets);

  const person = (g) => GENDER[String(g)] || '—';
  const officer = (empId) => {
    const e = employees.get(String(empId));
    if (!e) return null;
    const unit = units.get(String(e.UnitID));
    return {
      name: e.FirstName,
      rank: ranks.get(String(e.RankID))?.RankName || '',
      designation: designations.get(String(e.DesignationID))?.DesignationName || '',
      kgid: e.KGID,
      station: unit?.UnitName || '',
      phone: officerPhone(empId),
    };
  };

  return cases.map((c) => {
    const unit = units.get(String(c.PoliceStationID));
    const district = unit ? districts.get(String(unit.DistrictID))?.DistrictName : '';
    const key = String(c.CaseMasterID);
    return {
      id: c.CaseMasterID,
      crimeNo: c.CrimeNo,
      caseNo: c.CaseNo,
      registeredDate: c.CrimeRegisteredDate,
      incidentFrom: c.IncidentFromDate,
      incidentTo: c.IncidentToDate,
      infoReceived: c.InfoReceivedPSDate,
      category: CATEGORY[String(c.CaseCategoryID)] || '—',
      gravity: GRAVITY[String(c.GravityOffenceID)] || '—',
      heinous: String(c.GravityOffenceID) === '1',
      crimeHead: heads.get(String(c.CrimeMajorHeadID))?.CrimeGroupName || '—',
      crimeType: subheads.get(String(c.CrimeMinorHeadID))?.CrimeHeadName || '—',
      status: statuses.get(String(c.CaseStatusID))?.CaseStatusName || '—',
      court: courts.get(String(c.CourtID))?.CourtName || '—',
      station: unit?.UnitName || '—',
      district: district || '—',
      lat: c.latitude,
      lng: c.longitude,
      briefFacts: c.BriefFacts || '',
      officer: officer(c.PolicePersonID),
      complainants: (cById.get(key) || []).map((r) => ({
        name: r.ComplainantName, age: r.AgeYear, gender: person(r.GenderID),
        occupation: occupations.get(String(r.OccupationID))?.OccupationName || '',
        religion: religions.get(String(r.ReligionID))?.ReligionName || '',
        caste: castes.get(String(r.CasteID))?.caste_master_name || '',
      })),
      victims: (vById.get(key) || []).map((r) => ({
        name: r.VictimName, age: r.AgeYear, gender: person(r.GenderID),
        isPolice: String(r.VictimPolice) === '1',
      })),
      accused: (aById.get(key) || []).map((r) => ({
        name: r.AccusedName, age: r.AgeYear, gender: person(r.GenderID), tag: r.PersonID,
      })),
      arrests: (arrById.get(key) || []).map((r) => ({
        type: ARREST_TYPE[String(r.ArrestSurrenderTypeID)] || '—', date: r.ArrestSurrenderDate,
        io: officer(r.IOID),
      })),
      sections: (asById.get(key) || []).map((r) => {
        const act = acts.get(String(r.ActID));
        return {
          act: act?.ShortName || r.ActID,
          section: r.SectionID,
          desc: secMap.get(`${r.ActID}|${r.SectionID}`) || '',
        };
      }),
      chargesheet: (csById.get(key) || [])[0] || null,
    };
  });
}
