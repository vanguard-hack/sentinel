'use strict';

/*
 * Text → ZCQL for the Karnataka FIR Data Store.
 *
 * The Data Store tables use plain Int reference columns (no Foreign Key column
 * type), and ZCQL only supports JOIN between tables with a declared FK
 * relationship — so JOINs are unavailable. The design is therefore:
 *   1. The LLM writes a SINGLE-TABLE query, filtering/grouping by ID columns
 *      (enums and district→ID mappings are given in the prompt).
 *   2. The function enriches result rows in code (ID → human-readable name)
 *      using masters.json (a snapshot of the small master tables).
 *   3. District-level aggregation on CaseMaster is done by grouping on
 *      PoliceStationID and rolling stations up to districts in code
 *      (plan.rollup === 'district').
 */

const MASTERS = require('./masters.json');

const DISTRICT_IDS = Object.fromEntries(
  Object.entries(MASTERS.districts)
    .filter(([id]) => Number(id) < 5000)
    .map(([id, name]) => [name, id])
);
const STATIONS_BY_DISTRICT = {};
for (const [uid, u] of Object.entries(MASTERS.units)) {
  if (u.name.includes('Police Station')) {
    (STATIONS_BY_DISTRICT[u.district] = STATIONS_BY_DISTRICT[u.district] || []).push(uid);
  }
}

// ── router ──────────────────────────────────────────────────────────────────
const ROUTER_PROMPT =
  'You are a router for a police crime-analytics assistant. Decide how a ' +
  'question should be answered and reply with EXACTLY one word: ZCQL or RAG.\n\n' +
  'Answer ZCQL when the question asks about records, counts, statistics, lists, ' +
  'rankings, trends or lookups over the FIR relational database, which contains: ' +
  'FIR cases 2023-2026 (CaseMaster with station, district, category, status, crime ' +
  'head/sub-head, gravity, dates, coordinates), complainants, victims, accused, ' +
  'arrests/surrenders, chargesheets, act-section charges, and masters for acts, ' +
  'sections, crime heads, courts, districts, states, police stations/units, ranks, ' +
  'designations, employees/officers, religions, castes, occupations.\n\n' +
  'Answer RAG when the question is about law/procedure explanations, FAQs, ' +
  'definitions, how-to guidance, document contents, or anything not answerable ' +
  'from those tables.\n\n' +
  'If a question could plausibly be answered either way (e.g. any count, "top N", ' +
  'ranking, per-district/per-station/per-year statistic), ALWAYS prefer ZCQL — ' +
  'the database is the authoritative, current source.\n' +
  'Examples: "How many FIRs in 2024?" → ZCQL. "Top 5 districts by cases" → ZCQL. ' +
  '"Which officer registered the most cases?" → ZCQL. "What is a cognizable ' +
  'offence?" → RAG. "What does Section 379 IPC say?" → RAG.';

// ── schema + rules for the generator ────────────────────────────────────────
const districtLines = Object.entries(DISTRICT_IDS)
  .map(([name, id]) => `${name}=${id}`)
  .join(', ');

const SCHEMA = `FACT TABLES (query these; one table per query):
CaseMaster(CaseMasterID, CrimeNo, CaseNo, CrimeRegisteredDate DATE, PolicePersonID, PoliceStationID, CaseCategoryID, GravityOffenceID, CrimeMajorHeadID, CrimeMinorHeadID, CaseStatusID, CourtID, IncidentFromDate DATETIME, IncidentToDate DATETIME, InfoReceivedPSDate DATETIME, latitude, longitude, BriefFacts)
ComplainantDetails(ComplainantID, CaseMasterID, ComplainantName, AgeYear, OccupationID, ReligionID, CasteID, GenderID)
Victim(VictimMasterID, CaseMasterID, VictimName, AgeYear, GenderID, VictimPolice)
Accused(AccusedMasterID, CaseMasterID, AccusedName, AgeYear, GenderID, PersonID)
ArrestSurrender(ArrestSurrenderID, CaseMasterID, ArrestSurrenderTypeID, ArrestSurrenderDate DATE, ArrestSurrenderStateId, ArrestSurrenderDistrictId, PoliceStationID, IOID, CourtID, AccusedMasterID, IsAccused BOOLEAN, IsComplainantAccused BOOLEAN)
ChargesheetDetails(CSID, CaseMasterID, csdate DATETIME, cstype, PolicePersonID)
ActSectionAssociation(CaseMasterID, ActID, SectionID, ActOrderID, SectionOrderID)
MASTER TABLES (query directly only when the question is about the master itself):
Act(ActCode, ActDescription, ShortName), Section(ActCode, SectionCode, SectionDescription), CrimeHead(CrimeHeadID, CrimeGroupName), CrimeSubHead(CrimeSubHeadID, CrimeHeadID, CrimeHeadName), Court(CourtID, CourtName, DistrictID), District(DistrictID, DistrictName, StateID), Unit(UnitID, UnitName, TypeID, DistrictID), Employee(EmployeeID, DistrictID, UnitID, RankID, DesignationID, KGID, FirstName, EmployeeDOB, GenderID), Rank(RankID, RankName), Designation(DesignationID, DesignationName), CaseStatusMaster, CaseCategory, GravityOffence, ReligionMaster, CasteMaster, OccupationMaster, State, UnitType

ID VALUE MAPPINGS (use these numeric IDs in WHERE):
CaseCategoryID: 1=FIR, 3=UDR, 4=PAR, 8=Zero FIR
GravityOffenceID: 1=Heinous, 2=Non-Heinous
CaseStatusID: 1=Under Investigation, 2=Charge Sheeted, 3=Pending Trial, 4=Convicted, 5=Acquitted, 6=Closed - False Case, 7=Closed - Undetected
CrimeMajorHeadID: 1=Crimes Against Body, 2=Crimes Against Property, 3=Crimes Against Women, 4=Crimes Against Children, 5=Economic Offences, 6=Cyber Crimes, 7=Narcotics, 8=Public Order, 9=Traffic Offences, 10=Other Offences
GenderID: 1=Male, 2=Female, 3=Transgender
ArrestSurrenderTypeID: 1=Arrest, 2=Surrender
cstype: 'A'=Chargesheet, 'B'=False Case, 'C'=Undetected
ActID / ActCode values: 'IPC','BNS','NDPS','ARMS','IT','POCSO','MV','EXCISE','DP','KPA'
DistrictID by name (Karnataka): ${districtLines}
ArrestSurrender district filter: use ArrestSurrenderDistrictId = <DistrictID>.
CaseMaster has NO district column — for a district filter or district grouping
use PoliceStationID (each station belongs to one district) and set the rollup
field as described below.
Data covers 2023-01-01 to 2026-06-30.`;

const RULES = `RULES (follow ALL):
1. Reply with ONLY a JSON object, no fences:
   {"zcql": "<query>", "rollup": <"district" or null>, "topN": <number or null>}
2. The query must be ONE SELECT over ONE table. JOINs are NOT supported and
   will fail. Never reference a second table anywhere in the query.
3. Qualify every column as TableName.ColumnName.
4. Aggregates: COUNT, SUM, AVG, MIN, MAX, DISTINCT. Count rows with COUNT(ROWID).
   With aggregates, every plain selected column must be in GROUP BY.
5. "How many ..." questions with no per-X breakdown → a SINGLE aggregate with
   NO GROUP BY: SELECT COUNT(ROWID) FROM Table WHERE ... . Group ONLY when the
   user asks for a breakdown (per district / per status / top N ...).
6. No aliases, AS, subqueries, UNION, HAVING, or SELECT *.
7. WHERE supports =, !=, <, >, <=, >=, LIKE '%x%', IN (...), BETWEEN, IS NULL,
   AND, OR, parentheses. Strings/dates in single quotes; dates 'YYYY-MM-DD';
   year filter: Col BETWEEN '2024-01-01' AND '2024-12-31'. Booleans: true/false.
8. Filter by IDs using the mappings above; never invent IDs.
9. Per-district results from CaseMaster: GROUP BY CaseMaster.PoliceStationID,
   set "rollup":"district", and use LIMIT 400 (ALL stations must be included —
   the app re-aggregates stations into districts). Never LIMIT the station
   grouping to the requested N; put the requested N in "topN" instead.
   ArrestSurrender has ArrestSurrenderDistrictId, so group on that directly
   (rollup null).
10. "Top N" requests: set "topN": N. With rollup, keep LIMIT 400 as rule 9
    says; without rollup, also ORDER BY the aggregate DESC with LIMIT N.
11. When grouping, select the ID column plus COUNT(ROWID) only. The app maps
    IDs (stations, statuses, crime heads, officers, courts...) to names
    afterwards — do not worry about names.
12. Add only the filters the question asks for. Every query ends with LIMIT:
    200 for detail lists, 400 for GROUP BY queries.
13. Only SELECT — never INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE.
14. KNOW THE SCHEMA'S LIMITS. Religion, caste and occupation exist ONLY on
    ComplainantDetails (complainants). Accused and Victim have no religion,
    caste, occupation or address columns. If the question needs an attribute
    the schema does not record, or needs columns from TWO fact tables at once
    (e.g. accused attributes filtered by case attributes), do NOT approximate
    with an unrelated query — reply {"zcql": null, "reason": "<one sentence
    saying exactly what the database does not record>"} instead.`;

const ZCQL_SYSTEM =
  'You convert an analyst question into a single-table ZCQL query plan for the ' +
  'Zoho Catalyst Data Store below (Karnataka Police FIR database).\n\n' +
  SCHEMA + '\n\n' + RULES;

function buildUserPrompt(question, prevQuery, prevError) {
  let p = 'Question: ' + question;
  if (prevQuery && prevError) {
    p += `\n\nYour previous attempt:\n${prevQuery}\nfailed with error: ${prevError}\n` +
         'Produce a corrected plan following every rule (single table, no joins).';
  }
  return p;
}

// ── plan parsing & validation ────────────────────────────────────────────────
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|join)\b/i;

function parsePlan(raw) {
  if (!raw) return { ok: false, error: 'empty generation' };
  let txt = String(raw).trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) txt = fence[1].trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: 'no JSON object in output' };
  let plan;
  try {
    plan = JSON.parse(m[0]);
  } catch (e) {
    return { ok: false, error: 'invalid JSON: ' + e.message };
  }
  if (plan.zcql === null && plan.reason) {
    return { ok: true, unanswerable: String(plan.reason).slice(0, 400) };
  }
  let q = String(plan.zcql || '').replace(/;+\s*$/, '').replace(/\s+/g, ' ').trim();
  if (!/^select\b/i.test(q)) return { ok: false, error: 'query must start with SELECT' };
  if (FORBIDDEN.test(q)) return { ok: false, error: 'forbidden keyword (single-table SELECT only, no JOIN)' };
  if (q.includes(';')) return { ok: false, error: 'single statement only' };
  const tables = tablesInQuery(q);
  if (tables.length !== 1) return { ok: false, error: 'exactly one table per query' };
  const topN = Number.isInteger(plan.topN) && plan.topN > 0 ? plan.topN : null;
  return { ok: true, query: q, rollup: plan.rollup === 'district' ? 'district' : null, topN };
}

function tablesInQuery(q) {
  const found = new Set();
  const re = /\bfrom\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(q))) found.add(m[1]);
  return [...found];
}

// ── result shaping ───────────────────────────────────────────────────────────
function flattenRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const flat = {};
    for (const [tbl, cols] of Object.entries(row || {})) {
      if (cols && typeof cols === 'object') {
        for (const [k, v] of Object.entries(cols)) {
          flat[k in flat ? `${tbl}.${k}` : k] = v;
        }
      } else {
        flat[tbl] = cols;
      }
    }
    return flat;
  });
}

// ID column → { master map, replacement column name }
const ENRICH = {
  PoliceStationID: { map: 'units', label: 'PoliceStation' },
  UnitID: { map: 'units', label: 'Unit' },
  CaseStatusID: { map: 'statuses', label: 'CaseStatus' },
  CaseCategoryID: { map: 'categories', label: 'CaseCategory' },
  GravityOffenceID: { map: 'gravity', label: 'Gravity' },
  CrimeMajorHeadID: { map: 'crimeHeads', label: 'CrimeHead' },
  CrimeMinorHeadID: { map: 'crimeSubHeads', label: 'CrimeSubHead' },
  ReligionID: { map: 'religions', label: 'Religion' },
  CasteID: { map: 'castes', label: 'Caste' },
  OccupationID: { map: 'occupations', label: 'Occupation' },
  RankID: { map: 'ranks', label: 'Rank' },
  DesignationID: { map: 'designations', label: 'Designation' },
  CourtID: { map: 'courts', label: 'Court' },
  PolicePersonID: { map: 'employees', label: 'Officer' },
  IOID: { map: 'employees', label: 'Officer' },
  GenderID: { map: 'genders', label: 'Gender' },
  DistrictID: { map: 'districts', label: 'District' },
  ArrestSurrenderDistrictId: { map: 'districts', label: 'District' },
};

function lookupName(mapName, id) {
  const entry = MASTERS[mapName] && MASTERS[mapName][String(id)];
  if (entry === undefined) return null;
  return mapName === 'units' ? entry.name : entry;
}

// Replace known ID columns with readable names (keeps column order).
function enrichRows(flat) {
  return flat.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      const rule = ENRICH[k];
      const name = rule && v != null && v !== '' ? lookupName(rule.map, v) : null;
      if (name !== null && name !== undefined) out[rule.label] = name;
      else out[k] = v;
    }
    return out;
  });
}

// Station-grouped counts → district totals. Expects rows with PoliceStationID
// (or a station name after enrichment is NOT yet applied — call before enrich)
// plus one numeric aggregate column.
function rollupToDistricts(flat) {
  const stationKey = Object.keys(flat[0] || {}).find((k) => k === 'PoliceStationID');
  if (!stationKey) return null;
  const numKey = Object.keys(flat[0]).find((k) => k !== stationKey && isNum(flat[0][k]));
  if (!numKey) return null;
  const totals = {};
  for (const row of flat) {
    const unit = MASTERS.units[String(row[stationKey])];
    const dname = unit ? MASTERS.districts[unit.district] : 'Unknown';
    totals[dname] = (totals[dname] || 0) + Number(row[numKey] || 0);
  }
  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .map(([District, Count]) => ({ District, [numKey]: Count }));
}

const isNum = (v) => v !== '' && v !== null && v !== undefined && !isNaN(Number(v));

// Deterministic agui components from result rows.
function rowsToComponents(flat, title) {
  if (!flat.length) return [];
  const columns = Object.keys(flat[0]);
  if (flat.length === 1 && columns.length === 1) return [];

  if (columns.length === 2 && flat.length >= 2 && flat.length <= 15 &&
      flat.every((r) => isNum(r[columns[1]])) &&
      !flat.every((r) => isNum(r[columns[0]]))) {
    return [{
      type: 'bar-chart',
      title: title || `${columns[1]} by ${columns[0]}`,
      data: flat.map((r) => ({ label: String(r[columns[0]]), value: Number(r[columns[1]]) })),
    }];
  }

  return [{
    type: 'table',
    title: title || 'Query results',
    columns,
    rows: flat.slice(0, 100).map((r) => columns.map((c) => (r[c] == null ? '' : String(r[c])))),
  }];
}

module.exports = {
  ROUTER_PROMPT,
  ZCQL_SYSTEM,
  buildUserPrompt,
  parsePlan,
  flattenRows,
  enrichRows,
  rollupToDistricts,
  rowsToComponents,
  tablesInQuery,
};
