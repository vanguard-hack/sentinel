// Router + redaction checks. Run: node functions/rag/router.test.js
const redaction = require('./redaction');

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : (fail++, console.log('FAIL ' + name)); if (cond) console.log('ok  ' + name); };

// The routing helpers live inside index.js's module scope, so they are
// re-declared here from the same source to keep this test dependency-free.
const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('missing ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
};
const consts = src.match(/^const (?:CRIME_NO_RE|BARE_CRIME_NO_RE|STATS_RE|SOP_RE|ROUTE_CONFIDENCE_FLOOR) = .*$/gm).join('\n');
// eslint-disable-next-line no-new-func
const { deterministicRoute, parseRouteReply } = new Function(
  consts + '\n' + grab('deterministicRoute') + '\n' + grab('parseRouteReply') +
  '\nreturn { deterministicRoute, parseRouteReply };'
)();

// ── Deterministic override ────────────────────────────────────────────────
check('an FIR number skips the classifier',
  deterministicRoute('show me details of FIR 4029/2025')?.route === 'ZCQL');
check('a bare crime number is recognised',
  deterministicRoute('what happened in 112/2024')?.route === 'ZCQL');
check('aggregate language routes to the data store',
  deterministicRoute('how many thefts per district last month')?.route === 'ZCQL');
check('record id + procedure is mixed intent, not a coin flip',
  deterministicRoute('what is the procedure for FIR 4029/2025')?.route === 'BOTH');
check('a pure procedure question is left to the classifier',
  deterministicRoute('what is the procedure for filing a chargesheet') === null);
check('small talk is left to the classifier',
  deterministicRoute('thanks, that helps') === null);

// ── Confidence parsing ────────────────────────────────────────────────────
check('a scored JSON reply is parsed',
  parseRouteReply('{"route":"ZCQL","confidence":0.82}')?.confidence === 0.82);
check('a bare word still routes', parseRouteReply('RAG')?.route === 'RAG');
check('a bare word is not treated as high confidence',
  parseRouteReply('RAG').confidence < 0.75);
check('an unparseable reply yields no route', parseRouteReply('¯\\_(ツ)_/¯') === null);
check('confidence is clamped to 0..1',
  parseRouteReply('{"route":"RAG","confidence":7}').confidence === 1);
check('an unknown route name is rejected, not passed through',
  parseRouteReply('{"route":"SQL","confidence":0.9}') === null);

// ── Tier 1: clearance filter ──────────────────────────────────────────────
const rows = [{ CrimeNo: '42/2026', VictimName: 'A Kumar', AccusedName: 'B Rao', latitude: 12.9, Total: 7 }];
const asAnalyst = redaction.filterRows(rows, 'analyst');
const asInvestigator = redaction.filterRows(rows, 'investigator');
check('an analyst never receives victim identity',
  asAnalyst.rows[0].VictimName === '[redacted]');
check('an analyst never receives a precise location',
  asAnalyst.rows[0].latitude === '[redacted]');
check('aggregates survive redaction, so analytics still work',
  asAnalyst.rows[0].Total === 7 && asAnalyst.rows[0].CrimeNo === '42/2026');
check('an investigator sees the case they are working',
  asInvestigator.rows[0].VictimName === 'A Kumar');
check('an unidentified caller gets the strictest treatment',
  redaction.filterRows(rows, null).rows[0].AccusedName === '[redacted]');
check('redactions are reported for the audit trail',
  asAnalyst.redactions.some((r) => r.field === 'VictimName' && r.count === 1));

// ── Tier 2: post-generation guardrail ─────────────────────────────────────
const g = redaction.guardAnswer('Contact the complainant on 9845012345 or a.kumar@ksp.gov.in.', 'analyst');
check('a phone number restated by the model is caught', !/9845012345/.test(g.answer));
check('an email restated by the model is caught', !/a\.kumar@/.test(g.answer));
check('an Aadhaar number is caught',
  !/2345 6789 0123/.test(redaction.guardAnswer('Aadhaar 2345 6789 0123', 'analyst').answer));
check('an investigator answer is left intact',
  /9845012345/.test(redaction.guardAnswer('Call 9845012345', 'investigator').answer));
check('a crime number is not mistaken for an identifier',
  redaction.guardAnswer('FIR 42/2026 is open.', 'analyst').answer === 'FIR 42/2026 is open.');
check('a plain year is not redacted',
  redaction.guardAnswer('Filed in 2024 at Ashok Nagar.', 'analyst').answer === 'Filed in 2024 at Ashok Nagar.');

console.log(fail ? `\n${fail} FAILED, ${pass} passed.` : `\nAll ${pass} router/redaction checks passed.`);
process.exit(fail ? 1 : 0);
