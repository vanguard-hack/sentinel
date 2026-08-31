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
const KSP = __dirname + '/../../ksp/fir';
const parse = (f) => {
  const lines = fs.readFileSync(`${KSP}/${f}`, 'utf8').replace(/\r/g, '').trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const v = l.split(',');
    return Object.fromEntries(head.map((k, i) => [k, v[i]]));
  });
};
const TABLES = {
  CaseMaster: parse('CaseMaster.csv'),
  Accused: parse('Accused.csv'),
  Victim: parse('Victim.csv'),
  ArrestSurrender: parse('ArrestSurrender.csv'),
  Unit: parse('Unit.csv'),
  District: parse('District.csv'),
};

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
const app = {
  zcql: () => ({
    executeZCQLQuery: async (q) => {
      const lim = q.match(/LIMIT (\d+),\s*(\d+)/i);
      const from = q.match(/FROM (\w+)/i)[1];
      const where = q.match(/WHERE (.+?)(?:\s+LIMIT|$)/i);
      let rows = TABLES[from] || [];
      if (where) rows = rows.filter((r) => evalWhere(r, where[1]));
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

  try { fs.unlinkSync(db); } catch { /* leave it */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
