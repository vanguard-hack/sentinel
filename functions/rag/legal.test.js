// Legal reference. Run: node functions/rag/legal.test.js
//
// This answers "what is the punishment", "is it bailable", "what is the BNS
// equivalent" — sentences that end up in an officer's charge sheet. So the
// tests hold three things above correctness of any single lookup:
//   • the KB covers exactly the sections the case data can charge, so the
//     assistant is never asked about a provision it silently lacks;
//   • a miss is an explicit "not here", never a quiet empty result, because the
//     alternative is the model filling the gap from memory;
//   • the provenance caveat rides on every answer. These entries were drafted,
//     not gazetted.
const fs = require('fs');
const legal = require('./legal');
const tools = require('./tools');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// ── Coverage: the KB must match the data ──────────────────────────────────
const csv = fs.readFileSync(`${__dirname}/../../ksp/fir/Section.csv`, 'utf8')
  .replace(/\r/g, '').trim().split('\n').slice(1)
  .map((l) => { const [act, sec] = l.split(','); return `${act} ${sec}`; });
const kbKeys = new Set(legal.SECTIONS.map((e) => `${e.act} ${e.section}`));
const missing = csv.filter((k) => !kbKeys.has(k));
check('every section the case data can charge is in the KB', missing.length === 0, missing.join(', '));
check('the KB adds nothing the data cannot charge',
  legal.SECTIONS.every((e) => csv.includes(`${e.act} ${e.section}`)));

// ── Lookup ────────────────────────────────────────────────────────────────
const s302 = legal.findSection('IPC', '302');
check('a section is found by act and number', s302 && s302.title === 'Murder');
check('an officer\'s shorthand resolves ("u/s 302", "Section 302", "s.302")',
  ['u/s 302', 'Section 302', 's.302', '302'].every((f) => legal.findSection('IPC', f)?.section === '302'));
check('an alphanumeric section works', legal.findSection('IPC', '498A')?.title.includes('Cruelty'));
check('act aliases resolve', legal.normAct('IT Act') === 'IT' && legal.normAct('Indian Penal Code') === 'IPC');

const bailable = legal.findSection('IPC', '379');
check('bail classification is present and boolean', bailable.bailable === false);
check('cognizability is present and boolean', bailable.cognizable === true);
check('punishment is stated', /3 years/.test(bailable.punishment));

// ── The BNS transition ────────────────────────────────────────────────────
const toBns = legal.mapToBns('379');
check('IPC maps to its BNS equivalent', toBns.bns_equivalent === '303(2)');
check('the mapping states the commencement cutoff', /1 July 2024/.test(toBns.note));

const back = legal.mapFromBns('103(1)');
check('BNS maps back to IPC', back.found && back.ipc_equivalents[0].section === '302');

// The correctness point a naive KB gets wrong.
const ndps = legal.mapToBns('20', 'NDPS');
check('a special law reports NO BNS equivalent', ndps.bns_equivalent === null);
check('and says WHY, so it does not read as missing data',
  /replaced the Indian Penal Code only/i.test(ndps.note));
check('every non-IPC entry has a null BNS equivalent',
  legal.SECTIONS.filter((e) => e.act !== 'IPC').every((e) => e.bns_equivalent === null));
check('every IPC entry HAS a BNS equivalent',
  legal.SECTIONS.filter((e) => e.act === 'IPC').every((e) => !!e.bns_equivalent));

// ── Search ────────────────────────────────────────────────────────────────
check('an offence in plain words finds its section',
  legal.searchLaw('murder').some((e) => e.section === '302'));
check('online cheating finds the IT Act provision',
  legal.searchLaw('cheating by personation computer').some((e) => e.section === '66D'));

// ── Refusing rather than inventing ────────────────────────────────────────
const absent = tools.lookupLaw({ operation: 'section', section: '124A' });
check('a section outside the KB is an explicit miss', absent.found === false);
check('and tells the model not to answer from memory', /not answer from memory/i.test(absent.note));
check('the miss names what IS covered', /IPC/.test(absent.note));

// "Section 4" is POCSO 4 (penetrative sexual assault) AND DP 4 (demanding
// dowry). Guessing between those two would be a serious error, so an
// unqualified number must come back as a choice.
const ambiguous = legal.findSection(null, '4');
check('a number in more than one act is not silently guessed',
  ambiguous && Array.isArray(ambiguous.ambiguous) && ambiguous.ambiguous.length === 2);
check('naming the act disambiguates it',
  /penetrative/i.test(legal.findSection('POCSO', '4').title)
  && /demanding dowry/i.test(legal.findSection('DP', '4').title));

// ── Provenance ────────────────────────────────────────────────────────────
check('nothing claims to be verified', legal.SECTIONS.every((e) => e.verified !== true));
const presented = tools.lookupLaw({ operation: 'section', section: '302' });
check('an answer carries the caveat', /not verified against the official gazette/i.test(presented.disclaimer));
check('and reports its unverified status as a field', presented.verified === false);
for (const op of ['search', 'to_bns', 'from_bns', 'list_act']) {
  const r = tools.lookupLaw({ operation: op, section: '302', act: 'IPC', query: 'theft' });
  check(`the caveat rides on "${op}" too`, typeof r.disclaimer === 'string' && r.disclaimer.length > 0);
}

// ── Tool wiring ───────────────────────────────────────────────────────────
(async () => {
  const viaDispatch = await tools.run('lookup_law', { operation: 'section', section: '420' }, { role: null });
  check('the tool dispatches without needing a Data Store', viaDispatch.found === true);
  check('published law is not clearance-filtered', viaDispatch.title.includes('Cheating'));

  const def = tools.DEFINITIONS.find((d) => d.name === 'lookup_law');
  check('the tool is registered', !!def);
  check('it forbids answering from the model\'s own knowledge', /own knowledge/i.test(def.description));
  check('it explains the special-law rule to the model', /replaced the IPC only/i.test(def.description));
  check('it declares its operations', def.input_schema.properties.operation.enum.length === 5);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
