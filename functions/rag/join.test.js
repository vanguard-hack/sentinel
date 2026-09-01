// join_records against the real seed data. Run: node functions/rag/join.test.js
//
// This tool exists because model-orchestrated joins produced a silently wrong
// number. Measured: asked for arrests in Crimes-Against-Women cases, the model
// read 222 case ids, wrote "IN (9,30)" because the list did not survive its own
// output, and reported a confident count computed from two of them. So these
// tests check the COUNTS against ground truth computed independently, not just
// that a call succeeds.
const fs = require('fs');
const { execFileSync } = require('child_process');
const tools = require('./tools');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// The seed CSVs stand in for the Data Store, served through the same paged
// interface app.zcql() presents. Built once into an in-memory table set.
//
// WHERE THE DATA COMES FROM
//
// The seed CSVs are gitignored — they are ~1 MB of regenerable synthetic
// records (ksp/fir/generate_fir_dataset.py), and committing bulk data to make a
// test run is the wrong trade. But this suite reading them directly meant it
// passed locally and failed on CI with ENOENT, which is worse than either
// option: a test that only runs on one machine.
//
// So: use the real seed when it is there, and generate a fixture when it is
// not. Nothing below asserts a hardcoded count — every expectation is computed
// from the same data by sqlite — so both modes assert the same property, that
// the tool's answer matches SQL's over whatever it was given.
const TABLE_NAMES = ['CaseMaster', 'Accused', 'Victim', 'ArrestSurrender', 'Unit', 'District'];
const SEED = __dirname + '/../../ksp/fir';
const haveSeed = fs.existsSync(`${SEED}/CaseMaster.csv`);

/**
 * A deterministic stand-in, shaped like the seed and big enough to matter.
 *
 * 400 cases with 800 accused and 800 arrests, so a join crosses joinRecords'
 * 300-row page boundary — the paging is the whole reason this tool exists, and
 * a fixture that fitted in one page would test everything except the bug.
 * No randomness: the same fixture every run, on every machine.
 *
 * Stations come from masters.json rather than being invented. joinRecords
 * resolves a district name through masters.json, NOT through the Unit table,
 * so a fixture that made up its own station ids would have the tool and the
 * sqlite ground truth reading two different maps — which is exactly what the
 * first version of this did, and it failed the two district tests while the
 * tool was behaving correctly.
 */
function buildFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const csv = (name, header, rows) =>
    fs.writeFileSync(`${dir}/${name}.csv`, [header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n');

  const masters = require('./masters.json');
  const districtId = (name) =>
    Object.entries(masters.districts).find(([, n]) => String(n).toLowerCase() === name.toLowerCase())[0];
  const unitsIn = (id) =>
    Object.entries(masters.units).filter(([, u]) => String(u.district) === String(id)).map(([uid]) => uid);

  // The two districts the tests name, plus their real station ids.
  const named = ['Bengaluru City', 'Mysuru'].map((n) => ({ name: n, id: districtId(n), units: unitsIn(districtId(n)) }));
  const stations = named.flatMap((d) => d.units);

  const cases = [];
  for (let i = 1; i <= 400; i++) {
    // Spread across the values the tests filter on: major heads 3 (crimes
    // against women) and 7 (narcotics) both land, as do statuses 1-5.
    cases.push([i, (i % 8) + 1, (i % 5) + 1, (i % 3) + 1, stations[i % stations.length]]);
  }
  csv('CaseMaster', ['CaseMasterID', 'CrimeMajorHeadID', 'CaseStatusID', 'CaseCategoryID', 'PoliceStationID'], cases);

  const accused = [];
  const victims = [];
  const arrests = [];
  for (let i = 1; i <= 400; i++) {
    accused.push([accused.length + 1, i], [accused.length + 2, i]);
    victims.push([victims.length + 1, i]);
    arrests.push([arrests.length + 1, i, 1], [arrests.length + 2, i, 2]);
  }
  csv('Accused', ['AccusedID', 'CaseMasterID'], accused);
  csv('Victim', ['VictimID', 'CaseMasterID'], victims);
  csv('ArrestSurrender', ['ArrestSurrenderID', 'CaseMasterID', 'ArrestSurrenderTypeID'], arrests);

  // Unit and District mirror masters.json, so the SQL ground truth walks the
  // same district -> station map the tool does.
  csv('Unit', ['UnitID', 'DistrictID'], named.flatMap((d) => d.units.map((u) => [u, d.id])));
  csv('District', ['DistrictID', 'DistrictName'], named.map((d) => [d.id, d.name]));
}

const KSP = haveSeed
  ? SEED
  : (() => {
    const dir = `${require('os').tmpdir()}/sentinel-jointest`;
    buildFixture(dir);
    return dir;
  })();
console.log(haveSeed
  ? '(using the real seed data in ksp/fir)'
  : '(seed CSVs absent — running against the generated fixture)');

const parse = (f) => {
  const lines = fs.readFileSync(`${KSP}/${f}`, 'utf8').replace(/\r/g, '').trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const v = l.split(',');
    return Object.fromEntries(head.map((k, i) => [k, v[i]]));
  });
};
const TABLES = Object.fromEntries(TABLE_NAMES.map((t) => [t, parse(`${t}.csv`)]));

// A deliberately small ZCQL stand-in: enough to serve what joinRecords emits
// (SELECT cols FROM T [WHERE simple AND ...] LIMIT off,n) and nothing more.
function evalWhere(row, where) {
  // Split on AND, but not inside an IN(...) list. Stripping a trailing ")"
  // blindly ate the close of "IN (1001,1002)" and made every district query
  // look like a tool failure — the stub was wrong, not the tool.
  const parts = where.split(/\s+AND\s+(?![^(]*\))/i);
  return parts.every((cl) => {
    let c = cl.trim();
    if (c.startsWith('(') && c.endsWith(')') && !/^\([^)]*\)\s*\S/.test(c)) c = c.slice(1, -1).trim();
    let m = c.match(/^(?:\w+\.)?(\w+)\s+IN\s*\(([^)]*)\)$/i);
    if (m) return m[2].split(',').map((x) => x.trim().replace(/'/g, '')).includes(String(row[m[1]]));
    m = c.match(/^(?:\w+\.)?(\w+)\s*=\s*'?([^'\s]+)'?$/);
    if (m) return String(row[m[1]]) === String(m[2]);
    throw new Error('test stub cannot evaluate: ' + c);
  });
}
// The attach step queries by chunks of case id, so the fake has to answer an
// IN clause without rescanning the table — 75 chunks against 44,000 accused
// rows is three million predicate evaluations, and the suite went from seconds
// to nearly two minutes. A real Data Store has an index on this column; the
// fake now behaves the same way.
const BY_CASE = {};
const byCase = (table) => {
  if (!BY_CASE[table]) {
    const idx = new Map();
    for (const r of TABLES[table] || []) {
      const k = String(r.CaseMasterID);
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push(r);
    }
    BY_CASE[table] = idx;
  }
  return BY_CASE[table];
};

const app = {
  zcql: () => ({
    executeZCQLQuery: async (q) => {
      const lim = q.match(/LIMIT (\d+),\s*(\d+)/i);
      const from = q.match(/FROM (\w+)/i)[1];
      const where = q.match(/WHERE (.+?)(?:\s+LIMIT|$)/i);
      let rows = TABLES[from] || [];
      const inClause = where && where[1].match(/^\w+\.CaseMasterID IN \(([^)]*)\)(?:\s+AND\s+\((.+)\))?$/i);
      if (inClause) {
        const idx = byCase(from);
        const ids = inClause[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
        rows = ids.flatMap((id) => idx.get(id) || []);
        if (inClause[2]) rows = rows.filter((r) => evalWhere(r, inClause[2]));
      } else if (where) rows = rows.filter((r) => evalWhere(r, where[1]));
      const off = lim ? Number(lim[1]) : 0;
      const n = lim ? Number(lim[2]) : rows.length;
      return rows.slice(off, off + n).map((r) => ({ [from]: r }));
    },
  }),
};

// Ground truth, computed directly from the CSVs — independent of the tool.
const sqlite = (q) => {
  const out = execFileSync('sqlite3', ['-json', '-readonly', `${__dirname}/../../ksp/.jointest.db`], { input: q, encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : [];
};
function buildDb() {
  const db = `${__dirname}/../../ksp/.jointest.db`;
  if (fs.existsSync(db)) fs.unlinkSync(db);
  let script = '.mode csv\n';
  for (const t of Object.keys(TABLES)) script += `.import --csv '${KSP}/${t}.csv' ${t}\n`;
  execFileSync('sqlite3', [db], { input: script });
  return db;
}

(async () => {
  const db = buildDb();
  const truth = (q) => Object.values(sqlite(q)[0])[0];

  // ── The question the model got wrong ─────────────────────────────────────
  const arrestsTruth = truth(`SELECT COUNT(*) FROM ArrestSurrender WHERE CaseMasterID IN
    (SELECT CaseMasterID FROM CaseMaster WHERE CrimeMajorHeadID=3)`);
  const arrests = await tools.joinRecords(app, {
    base: 'CaseMaster', where: 'CaseMaster.CrimeMajorHeadID = 3', attach: 'ArrestSurrender', count_only: true,
  }, 'admin');
  check('arrests in Crimes-Against-Women cases counts every case, not the few that fit a prompt',
    arrests.attached_count === arrestsTruth, `got ${arrests.attached_count}, truth ${arrestsTruth}`);

  // ── Fact -> fact ─────────────────────────────────────────────────────────
  const accTruth = truth(`SELECT COUNT(*) FROM Accused WHERE CaseMasterID IN
    (SELECT CaseMasterID FROM CaseMaster WHERE CaseStatusID=1)`);
  const acc = await tools.joinRecords(app, {
    base: 'CaseMaster', where: 'CaseMaster.CaseStatusID = 1', attach: 'Accused', count_only: true,
  }, 'admin');
  check('accused in cases under investigation', acc.attached_count === accTruth, `got ${acc.attached_count}, truth ${accTruth}`);

  // ── District resolution, which CaseMaster cannot express ─────────────────
  const firTruth = truth(`SELECT COUNT(*) FROM CaseMaster WHERE CaseCategoryID=1 AND PoliceStationID IN
    (SELECT UnitID FROM Unit WHERE DistrictID=(SELECT DistrictID FROM District WHERE DistrictName='Bengaluru City'))`);
  const fir = await tools.joinRecords(app, {
    base: 'CaseMaster', district: 'Bengaluru City', where: 'CaseMaster.CaseCategoryID = 1', count_only: true,
  }, 'admin');
  check('FIRs filtered by district name', fir.matched_cases === firTruth, `got ${fir.matched_cases}, truth ${firTruth}`);

  const vicTruth = truth(`SELECT COUNT(*) FROM Victim WHERE CaseMasterID IN
    (SELECT CaseMasterID FROM CaseMaster WHERE PoliceStationID IN
      (SELECT UnitID FROM Unit WHERE DistrictID=(SELECT DistrictID FROM District WHERE DistrictName='Mysuru')))`);
  const vic = await tools.joinRecords(app, {
    base: 'CaseMaster', district: 'Mysuru', attach: 'Victim', count_only: true,
  }, 'admin');
  check('victims in a district — two hops, no ids through the model',
    vic.attached_count === vicTruth, `got ${vic.attached_count}, truth ${vicTruth}`);

  // ── Filter on the attached table too ─────────────────────────────────────
  const arrOnlyTruth = truth(`SELECT COUNT(*) FROM ArrestSurrender WHERE ArrestSurrenderTypeID=1 AND CaseMasterID IN
    (SELECT CaseMasterID FROM CaseMaster WHERE CrimeMajorHeadID=7)`);
  const arrOnly = await tools.joinRecords(app, {
    base: 'CaseMaster', where: 'CaseMaster.CrimeMajorHeadID = 7',
    attach: 'ArrestSurrender', attach_where: 'ArrestSurrenderTypeID = 1', count_only: true,
  }, 'admin');
  check('arrests (not surrenders) in narcotics cases', arrOnly.attached_count === arrOnlyTruth,
    `got ${arrOnly.attached_count}, truth ${arrOnlyTruth}`);

  // ── Refusals and edges ───────────────────────────────────────────────────
  const bad = await tools.joinRecords(app, { base: 'CaseMaster', where: 'x = 1 OR 1=1; DROP TABLE Accused' }, 'admin');
  check('a filter carrying a second statement is rejected', !!bad.error);

  const badTable = await tools.joinRecords(app, { base: 'CaseMaster', attach: 'Employee' }, 'admin');
  check('an unjoinable table is refused with the list of real ones', /Cannot attach/.test(badTable.error || ''));

  const noDistrict = await tools.joinRecords(app, { base: 'CaseMaster', district: 'Atlantis' }, 'admin');
  check('an unknown district is an error, not an empty result', /No district/.test(noDistrict.error || ''));

  const empty = await tools.joinRecords(app, {
    base: 'CaseMaster', where: 'CaseMaster.CaseStatusID = 99', attach: 'Accused', count_only: true,
  }, 'admin');
  check('no matching cases says so rather than counting the whole table',
    empty.matched_cases === 0 && empty.attached_count === 0);

  // ── Clearance ────────────────────────────────────────────────────────────
  const asNobody = await tools.run('join_records',
    { base: 'CaseMaster', where: 'CaseMaster.CaseStatusID = 1', attach: 'Accused' }, { app, role: null });
  check('results pass through the clearance filter at dispatch', Array.isArray(asNobody._redactions));

  // ── Schema ───────────────────────────────────────────────────────────────
  const def = tools.DEFINITIONS.find((d) => d.name === 'join_records');
  check('the tool is registered', !!def);
  check('it warns the model off the truncating IN-list workaround',
    /truncat/i.test(def.description));
  const rollup = tools.DEFINITIONS.find((d) => d.name === 'query_records').input_schema.properties.rollup;
  check('rollup accepts null, so a model emitting it does not 400 the whole turn',
    Array.isArray(rollup.type) && rollup.type.includes('null'));



  // ── A short count must say it is short ───────────────────────────────────
  //
  // The attach step used to read the whole attached table and match in memory,
  // on the reasoning that the tables were small. At 2,200 cases that held. At
  // 30,000 it failed silently: pageAll stopped at the cap, so ArrestSurrender's
  // 25,000 rows were read down to the first 5,000 and the tool reported 532
  // arrests where the truth was 2,769 — a short count presented as a count,
  // which is the exact failure this tool was written to prevent.
  //
  // It now chunks by id, so the work scales with the filtered set rather than
  // the table. Where a filter genuinely exceeds the bound, the result says so.
  {
    const wide = await tools.joinRecords(app, {
      base: 'CaseMaster', attach: 'Accused', count_only: true,
    }, 'admin');
    const everyCase = truth('SELECT COUNT(*) FROM CaseMaster');
    if (everyCase > tools.MAX_IDS) {
      check('a filter past the bound reports itself incomplete', !!wide.note_incomplete,
        'a number that might be short must never be presented as a count');
      check('  and names the bound it hit', /first \d+ were counted/.test(wide.note_incomplete || ''));
      check('  and says what to do about it', /Narrow the filter/.test(wide.note_incomplete || ''));
    } else {
      check('a filter inside the bound carries no incompleteness note', !wide.note_incomplete);
    }
    const narrow = await tools.joinRecords(app, {
      base: 'CaseMaster', where: "CaseMaster.CrimeMinorHeadID = 1002", attach: 'Accused', count_only: true,
    }, 'admin');
    check('an ordinary filter is exact and unqualified',
      !narrow.note_incomplete
      && narrow.attached_count === truth(`SELECT COUNT(*) FROM Accused WHERE CaseMasterID IN
           (SELECT CaseMasterID FROM CaseMaster WHERE CrimeMinorHeadID=1002)`),
      `got ${narrow.attached_count}`);
    // The attach filter has to survive chunking, or every chunk after the first
    // would come back unfiltered.
    const arrestsOnly = await tools.joinRecords(app, {
      base: 'CaseMaster', where: 'CaseMaster.CrimeMajorHeadID = 7', attach: 'ArrestSurrender',
      attach_where: 'ArrestSurrender.ArrestSurrenderTypeID = 1', count_only: true,
    }, 'admin');
    check('an attach filter is applied to every chunk, not just the first',
      arrestsOnly.attached_count === truth(`SELECT COUNT(*) FROM ArrestSurrender
        WHERE ArrestSurrenderTypeID=1 AND CaseMasterID IN
          (SELECT CaseMasterID FROM CaseMaster WHERE CrimeMajorHeadID=7)`),
      `got ${arrestsOnly.attached_count}`);
  }

  try { fs.unlinkSync(db); } catch { /* leave it */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

