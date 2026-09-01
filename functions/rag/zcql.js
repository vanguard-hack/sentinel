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

const i18n = require('./i18n');
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


/**
 * Which police stations sit in a district.
 *
 * CaseMaster has no district column — a case belongs to a station, and a
 * station belongs to a district. The prompt told the model to filter on
 * PoliceStationID and then never gave it the station ids, so "crimes in Udupi"
 * was not a query the model could write however hard it tried. It said so, in
 * the honest way that reads to an officer as the system refusing.
 *
 * So the model now states the DISTRICT and this expands it. Same division of
 * labour as `rollup` and as join_records: the model states intent, the code
 * does the arithmetic it has the data for.
 */
function stationsInDistrict(name) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return null;
  const entries = Object.entries(MASTERS.districts || {});
  const exact = entries.find(([, dn]) => String(dn).toLowerCase() === needle);
  const loose = exact || entries.find(([, dn]) => String(dn).toLowerCase().includes(needle));
  if (!loose) return { error: `No district named "${name}".` };
  const [districtId, districtName] = loose;
  const stations = Object.entries(MASTERS.units || {})
    .filter(([, u]) => u && String(u.district) === String(districtId))
    .map(([id]) => id);
  return stations.length
    ? { districtId, districtName, stations }
    : { error: `No police stations are listed for "${districtName}".` };
}

/**
 * Add a station filter to a validated single-table query.
 *
 * String surgery on SQL is where bugs live, so the clause is inserted at a
 * position found in the LITERAL-MASKED copy — a case whose BriefFacts contains
 * the word "order" must not be mistaken for an ORDER BY — and the model's own
 * WHERE is wrapped in brackets rather than appended to, or an existing OR would
 * silently swallow the district restriction.
 */
function withStationFilter(query, table, stations) {
  if (!stations || !stations.length) return query;
  const clause = `${table}.PoliceStationID IN (${stations.join(',')})`;
  const { masked } = maskLiterals(query);

  // The first tail keyword marks where the WHERE clause ends.
  let cut = masked.length;
  for (const kw of [/\bgroup\s+by\b/i, /\border\s+by\b/i, /\blimit\b/i]) {
    const m = kw.exec(masked);
    if (m && m.index < cut) cut = m.index;
  }

  const head = query.slice(0, cut).trimEnd();
  const tail = query.slice(cut);
  const whereAt = /\bwhere\b/i.exec(masked.slice(0, cut));
  const next = whereAt
    ? `${head.slice(0, whereAt.index)}WHERE (${head.slice(whereAt.index + 5).trim()}) AND ${clause}`
    : `${head} WHERE ${clause}`;
  return `${next}${tail ? ` ${tail.trim()}` : ''}`;
}

// ── router ──────────────────────────────────────────────────────────────────
const ROUTER_PROMPT =
  'You are a router for a police crime-analytics assistant. Decide how a ' +
  'message should be answered and reply with EXACTLY one word: CHAT, GUIDE, ZCQL, RAG or TOOLS.\n\n' +
  'Answer CHAT when the ORIGINAL message is casual conversation rather than a ' +
  'lookup: greetings, thanks, goodbyes, small talk, jokes, feelings, or ' +
  'questions about the assistant itself ("who are you", "what can you do"). ' +
  'If the message asks for ANY police data, statistic, record, law or ' +
  'procedure, it is NOT chat.\n\n' +
  'Answer GUIDE when the message is about THIS Sentinel platform’s own ' +
  'features, screens, tabs or analytics tools — what a module does, where to ' +
  'find something, or how to use it. This covers the dashboard, incidents feed, ' +
  'crime map, AI Analytics and its tabs (crime patterns, crime links / ' +
  'co-offending network, case linkage, forecasts & risk, financial trails / ' +
  'money-laundering typologies), case files, investigation diary, personnel ' +
  'directory / duty roster / org chart, and access & audit. ' +
  'Examples: "show me the financial crime network trails" → GUIDE. ' +
  '"where do I see the co-offending network?" → GUIDE. ' +
  '"what does AI analytics do?" → GUIDE. "how do I view forecasts?" → GUIDE. ' +
  '"open personnel" / "take me to the crime map" → GUIDE. ' +
  'A request for the actual FIR numbers/records is ZCQL, not GUIDE.\n\n' +
  'Answer ZCQL when the question asks about records, counts, statistics, lists, ' +
  'rankings, trends or lookups over the FIR relational database, which contains: ' +
  'FIR cases 2023-2026 (CaseMaster with station, district, category, status, crime ' +
  'head/sub-head, gravity, dates, coordinates), complainants, victims, accused, ' +
  'arrests/surrenders, chargesheets, act-section charges, and masters for acts, ' +
  'sections, crime heads, courts, districts, states, police stations/units, ranks, ' +
  'designations, employees/officers, religions, castes, occupations.\n\n' +
  'Answer RAG when the question is about law/procedure explanations, FAQs, ' +
  'definitions, how-to guidance, document contents, or anything not answerable ' +
  'from those tables. ALSO answer RAG when the question asks to LIST the RECENT ' +
  'or LATEST FIRs / cases in a specific place (a city, district or police ' +
  'station) — these recent-FIR listings are served from the FIR knowledge-base ' +
  'document, NOT from ZCQL. Examples: "recent FIRs in Bengaluru City" → RAG. ' +
  '"latest cases in Mysuru" → RAG. "show me the newest FIRs in Hubli" → RAG.\n\n' +
  'If a question could plausibly be answered either way (e.g. any count, "top N", ' +
  'ranking, per-district/per-station/per-year statistic), ALWAYS prefer ZCQL — ' +
  'the database is the authoritative, current source. The ONE exception is the ' +
  'recent/latest-FIRs-in-a-place listing above, which goes to RAG.\n' +
  'Examples: "How many FIRs in 2024?" → ZCQL. "Top 5 districts by cases" → ZCQL. ' +
  '"Which officer registered the most cases?" → ZCQL. ' +
  '"recent FIRs in Bengaluru City" → RAG. "latest FIRs in Mysuru" → RAG. ' +
  '"What is a cognizable ' +
  'offence?" → RAG. "What does Section 379 IPC say?" → RAG. ' +
  '"Hey, how are you?" → CHAT. "thanks, that helped!" → CHAT. ' +
  '"good morning" → CHAT. "what all can you do?" → CHAT.\n\n' +
  'Answer TOOLS when ONE question needs MORE THAN ONE lookup to answer — most ' +
  'often because the second lookup depends on what the first one returns. The ' +
  'database cannot join tables, so any question spanning two of them needs this. ' +
  'Signals: a question that asks about records AND the people in them; a question ' +
  'that asks about records AND what the law or procedure says about them; a ' +
  'question that names one thing and asks for something related to it. ' +
  'Examples: "which FIRs were filed in Belagavi last month and who is accused in ' +
  'them?" → TOOLS (the cases, then the accused in those cases). ' +
  '"who is the officer on FIR 144011004202300002 and what else are they working ' +
  'on?" → TOOLS. "how many drug cases in Mysuru, and what does the NDPS Act say ' +
  'about them?" → TOOLS (records, then procedure). ' +
  '"compare arrests in Hubballi and Belagavi" → TOOLS. ' +
  'A question answerable by ONE query stays ZCQL — do not send simple counts, ' +
  'top-N rankings or single lookups here.';

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
CaseMaster has NO district column. Do NOT try to join Unit — it will fail.
To restrict to ONE district, put its name in the "district" field of your reply
and write the query WITHOUT any station or district condition; the station list
for that district is filled in for you. To break results down BY district,
GROUP BY CaseMaster.PoliceStationID and set "rollup":"district".
Data covers 2023-01-01 to 2026-06-30.`;

const RULES = `RULES (follow ALL):
1. Reply with ONLY a JSON object, no fences:
   {"zcql": "<query>", "rollup": <"district" or null>,
    "district": <"district name" or null>, "topN": <number or null>}
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
  "GLOSSARY: 'FIR', 'FIRs', 'firs', 'fir' mean First Information Report cases — " +
  'rows in CaseMaster with CaseCategoryID = 1 (never trees or anything else). ' +
  "'case', 'cases', 'crime', 'crimes' mean rows in CaseMaster (any category). " +
  "Example: 'how many firs in 2024' = SELECT COUNT(ROWID) FROM CaseMaster WHERE " +
  "CaseMaster.CaseCategoryID = 1 AND CaseMaster.CrimeRegisteredDate BETWEEN " +
  "'2024-01-01' AND '2024-12-31'.\n\n" +
  SCHEMA + '\n\n' + RULES;

function buildUserPrompt(question, prevQuery, prevError) {
  let p = 'Question: ' + question;
  if (prevQuery && prevError) {
    p += `\n\nYour previous attempt:\n${prevQuery}\nfailed with error: ${prevError}\n` +
         'Produce a corrected plan following every rule (single table, no joins).';
  }
  return p;
}

// ── ZCQL validator ───────────────────────────────────────────────────────────
// An explicit stage between generation and execution, not an instruction in
// the generation prompt — prompt-level rules are exactly what an injection
// attack targets, so the check has to sit outside the model's reach.
//
// It fails CLOSED: a query that cannot be proven safe is rejected with a
// reason, never silently rewritten into something that looks safe. Auto-
// correcting an adversarial query just hands the attacker a second attempt.
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|join|union|exec|execute|pragma|attach)\b/i;

// Hard ceiling on rows a single generated query may return. Prevents a
// table-wide scan being dressed up as a legitimate SELECT.
const MAX_ROWS = 300;

// Comments are stripped before any keyword check: `SELECT 1 /* */ , x FROM a`
// and `-- ` sequences are the classic way to smuggle syntax past a regex.
function stripComments(q) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    const next = q[i + 1];
    if (inStr) {
      out += c;
      if (c === "'") inStr = q[i + 1] === "'" ? (out += q[++i], true) : false;
      continue;
    }
    if (c === "'") { inStr = true; out += c; continue; }
    if (c === '-' && next === '-') { while (i < q.length && q[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < q.length && !(q[i] === '*' && q[i + 1] === '/')) i++;
      i++; out += ' '; continue;
    }
    out += c;
  }
  return out;
}

// Blank out string literals so a WHERE value containing the word "join" or a
// semicolon is judged as data, not as syntax.
function maskLiterals(q) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (inStr) {
      if (c === "'") {
        if (q[i + 1] === "'") { out += '  '; i++; continue; }
        inStr = false; out += "'";
      } else out += ' ';
      continue;
    }
    if (c === "'") { inStr = true; out += "'"; continue; }
    out += c;
  }
  return { masked: out, unterminated: inStr };
}

// The FROM clause runs to the next clause keyword. A comma inside it is a
// cross join in disguise — the JOIN keyword check alone does not catch
// `FROM CaseMaster, Accused`, which is how a second table gets smuggled in.
const CLAUSE_END = /\b(where|group\s+by|order\s+by|having|limit)\b/i;

function fromClause(masked) {
  const m = /\bfrom\b/i.exec(masked);
  if (!m) return null;
  const rest = masked.slice(m.index + m[0].length);
  const end = CLAUSE_END.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).trim();
}

// Returns { ok, query, error, checks } — `checks` is recorded in the audit
// trail so a reviewer can see what the validator decided and why.
function validateZcql(raw, opts = {}) {
  const maxRows = Number.isInteger(opts.maxRows) && opts.maxRows > 0 ? opts.maxRows : MAX_ROWS;
  const checks = [];
  const fail = (error) => ({ ok: false, error, checks: checks.concat(`FAIL:${error}`) });

  if (!raw || !String(raw).trim()) return fail('empty query');
  let q = stripComments(String(raw)).replace(/;+\s*$/, '').replace(/\s+/g, ' ').trim();
  checks.push('comments-stripped');

  const { masked, unterminated } = maskLiterals(q);
  if (unterminated) return fail('unterminated string literal');
  checks.push('literals-masked');

  if (!/^select\b/i.test(masked)) return fail('must start with SELECT');
  checks.push('select-only');

  const bad = FORBIDDEN.exec(masked);
  if (bad) return fail(`forbidden keyword "${bad[1]}"`);
  checks.push('no-write-or-join-keyword');

  if (masked.includes(';')) return fail('single statement only');
  checks.push('single-statement');

  const from = fromClause(masked);
  if (!from) return fail('no FROM clause');
  if (from.includes(',')) return fail('multiple tables in FROM (comma join)');
  const tables = tablesInQuery(masked);
  if (tables.length !== 1) return fail('exactly one table per query');
  checks.push(`single-table:${tables[0]}`);

  // Subqueries would let a second table in through the back door.
  if (/\(\s*select\b/i.test(masked)) return fail('subqueries are not permitted');
  checks.push('no-subquery');

  // An unbounded scan with no WHERE and no aggregate returns the table. Every
  // such query must be capped; an existing LIMIT is honoured but clamped.
  const hasWhere = /\bwhere\b/i.test(masked);
  const isAggregate = /\b(count|sum|avg|min|max)\s*\(/i.test(masked);
  const limitMatch = /\blimit\s+(\d+)\s*(?:,\s*(\d+))?\s*$/i.exec(masked);

  if (limitMatch) {
    const offset = limitMatch[2] !== undefined ? Number(limitMatch[1]) : 0;
    const count = limitMatch[2] !== undefined ? Number(limitMatch[2]) : Number(limitMatch[1]);
    if (count > maxRows) {
      q = q.slice(0, limitMatch.index).trim() + ` LIMIT ${offset}, ${maxRows}`;
      checks.push(`limit-clamped:${maxRows}`);
    } else {
      checks.push(`limit-ok:${count}`);
    }
  } else if (isAggregate) {
    // An aggregate collapses to a handful of rows; no cap needed.
    checks.push('aggregate-no-limit-needed');
  } else if (!hasWhere) {
    return fail('unfiltered query must have a LIMIT');
  } else {
    q = `${q} LIMIT 0, ${maxRows}`;
    checks.push(`limit-added:${maxRows}`);
  }

  return { ok: true, query: q, table: tables[0], checks };
}

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
  // Generation and validation are separate stages: whatever the model emits,
  // it only reaches execution if the validator passes it.
  const v = validateZcql(plan.zcql);
  if (!v.ok) return { ok: false, error: v.error, checks: v.checks };
  const topN = Number.isInteger(plan.topN) && plan.topN > 0 ? plan.topN : null;

  // A district filter is stated, not written. CaseMaster has no district
  // column, so the model names the district and the station expansion happens
  // here — after validation, so the injected clause cannot be a way to smuggle
  // syntax past the validator.
  let query = v.query;
  let district = null;
  if (typeof plan.district === 'string' && plan.district.trim()) {
    const resolved = stationsInDistrict(plan.district);
    if (resolved && resolved.error) return { ok: false, error: resolved.error, checks: v.checks };
    if (resolved && resolved.stations.length) {
      // Only CaseMaster carries PoliceStationID. Naming a district against any
      // other table is a mistake to report, not to quietly ignore — an officer
      // told "12 arrests in Udupi" when the filter never applied has been
      // misinformed in the most convincing way available.
      if (v.table !== 'CaseMaster') {
        return {
          ok: false,
          error: `A district filter only applies to CaseMaster, not ${v.table}. `
            + 'For arrests use ArrestSurrender.ArrestSurrenderDistrictId instead.',
          checks: v.checks,
        };
      }
      query = withStationFilter(v.query, v.table, resolved.stations);
      district = { name: resolved.districtName, stations: resolved.stations.length };
    }
  }

  return {
    ok: true,
    query,
    table: v.table,
    checks: district ? v.checks.concat(`district-filter:${district.name}`) : v.checks,
    rollup: plan.rollup === 'district' ? 'district' : null,
    district,
    topN,
  };
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

const KA_DISTRICTS = new Set(Object.keys(DISTRICT_IDS));

// Deterministic agui components from result rows.
function rowsToComponents(flat, title, lang) {
  if (!flat.length) return [];
  const columns = Object.keys(flat[0]);
  if (flat.length === 1 && columns.length === 1) return [];

  const labelIsDistrict =
    columns.length === 2 &&
    flat.some((r) => KA_DISTRICTS.has(String(r[columns[0]])));

  // Per-district numeric result → an interactive choropleth map + a table.
  if (labelIsDistrict && flat.every((r) => isNum(r[columns[1]]))) {
    return [
      {
        type: 'geo-map',
        title: title || i18n.t('component.byDistrict', lang, { column: columns[1] }),
        data: flat.map((r) => ({ district: String(r[columns[0]]), value: Number(r[columns[1]]) })),
      },
      {
        type: 'table',
        title: i18n.t('component.districtFigures', lang),
        columns,
        rows: flat.map((r) => columns.map((c) => (r[c] == null ? '' : String(r[c])))),
      },
    ];
  }

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
  validateZcql,
  stationsInDistrict,
  withStationFilter,
  MAX_ROWS,
};
