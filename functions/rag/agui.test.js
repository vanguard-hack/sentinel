// AG-UI generative-UI vocabulary and the safety net that keeps a stray
// markdown table or duplicated list out of the chat's plain-text renderer.
// Run: node functions/rag/agui.test.js

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');

// Lift the whole contiguous block — looksDataShaped through
// sanitizeForDisplay — out of the source and run the real thing, rather than
// asserting on how it reads. A guard tested by regex is a guard that passes
// while doing nothing.
const blockSrc = src.slice(src.indexOf('function looksDataShaped'), src.indexOf('function readBody('));
// eslint-disable-next-line no-new-func
const {
  looksDataShaped, extractAgui, AGUI_TYPES,
  stripMarkdownTables, promoteDistrictCharts, stripStrayCodeBlocks, stripDuplicatedLists,
  sanitizeForDisplay,
} = new Function(`${blockSrc}
return {
  looksDataShaped, extractAgui, AGUI_TYPES,
  stripMarkdownTables, promoteDistrictCharts, stripStrayCodeBlocks, stripDuplicatedLists,
  sanitizeForDisplay,
};`)();

const AGUI_SHAPES_SRC = src.slice(src.indexOf('const AGUI_SHAPES ='), src.indexOf('const AGUI_TRANSFORM ='));

// ── The vocabulary carries the three new component types ───────────────────
check('AGUI_TYPES accepts checklist', AGUI_TYPES.has('checklist'));
check('AGUI_TYPES accepts stat-tiles', AGUI_TYPES.has('stat-tiles'));
check('AGUI_TYPES accepts timeline', AGUI_TYPES.has('timeline'));
check('AGUI_SHAPES describes checklist to the model',
  /"type":"checklist"/.test(AGUI_SHAPES_SRC));
check('AGUI_SHAPES describes stat-tiles to the model',
  /"type":"stat-tiles"/.test(AGUI_SHAPES_SRC));
check('AGUI_SHAPES describes timeline to the model',
  /"type":"timeline"/.test(AGUI_SHAPES_SRC));

check('extractAgui accepts a checklist component',
  extractAgui('```agui\n{"components":[{"type":"checklist","title":"t","items":[{"label":"a","tone":"overdue"}]}]}\n```')
    .components.length === 1);

// ── sanitizeForDisplay: the actual bug fix ──────────────────────────────────
//
// The reported bug: a lane's model answer contained a raw markdown table
// ("| Crime head | Cases |") that the chat's plain-text renderer cannot
// parse, and nothing converted it into a real table component before it hit
// the wire. sanitizeForDisplay is the one function every lane must call to
// prevent that class of bug from ever reappearing lane-by-lane.
const crimeHeadTable =
  'Here is the breakdown by crime head.\n\n' +
  '| Crime head | Cases |\n' +
  '|---|---|\n' +
  '| Crimes Against Property | 222 |\n' +
  '| Crimes Against Body | 149 |\n' +
  '| Cyber Crimes | 140 |\n';

const sanitized = sanitizeForDisplay(crimeHeadTable, []);
check('a stray markdown table is removed from the prose',
  !/\|.*\|/.test(sanitized.text));
check('the greeting sentence above the table survives',
  /Here is the breakdown/.test(sanitized.text));
check('the table becomes a real table component instead of being lost',
  sanitized.components.length === 1 && sanitized.components[0].type === 'table');
check('the table component carries the real header row',
  JSON.stringify(sanitized.components[0].columns) === JSON.stringify(['Crime head', 'Cases']));
check('the table component carries every data row',
  sanitized.components[0].rows.length === 3
  && sanitized.components[0].rows[0][0] === 'Crimes Against Property'
  && sanitized.components[0].rows[0][1] === '222');

check('a table is left alone when a real table component already exists',
  sanitizeForDisplay(crimeHeadTable, [{ type: 'table', columns: ['x'], rows: [['y']] }])
    .components.length === 1);

check('a stray fenced code block is dropped, not just the agui one',
  !/```/.test(sanitizeForDisplay('some prose\n```text\nASCII CHART\n```\nmore prose', []).text));

check('a district bar chart is promoted to a geo-map',
  sanitizeForDisplay('', [{
    type: 'bar-chart',
    title: 'Cases',
    data: [
      { label: 'Bengaluru City', value: 10 },
      { label: 'Mysuru', value: 5 },
      { label: 'Belagavi', value: 3 },
    ],
  }]).components.some((c) => c.type === 'geo-map'));

check('a long duplicated list next to a component is dropped from the prose',
  !/Case A/.test(sanitizeForDisplay(
    'Summary.\n\n1. Case A\n2. Case B\n3. Case C\n',
    [{ type: 'table', columns: ['x'], rows: [['y']] }],
  ).text));

check('text with nothing to sanitize is returned unchanged',
  sanitizeForDisplay('Plain sentence, no markup.', []).text === 'Plain sentence, no markup.');

// ── Wiring: every lane must go through the one place that calls it ─────────
//
// The bug was never that stripMarkdownTables/etc. didn't work — it worked in
// the two lanes that remembered to call it. It's that most lanes didn't.
// respondWith is the single response exit every lane already funnels
// through (see sources.js / CLAUDE.md), so the fix belongs there, once.
const respondWithSrc = src.slice(src.indexOf('const respondWith = async'), src.indexOf('// ── Prompt-exfiltration refusal'));
check('respondWith itself calls sanitizeForDisplay, not a per-lane copy',
  /sanitizeForDisplay\(/.test(respondWithSrc));
check('the old per-lane manual sanitation calls are gone, not duplicated',
  !/stripMarkdownTables\(/.test(src.replace(respondWithSrc, '').replace(blockSrc, ''))
  && !/stripDuplicatedLists\(/.test(src.replace(respondWithSrc, '').replace(blockSrc, '')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
