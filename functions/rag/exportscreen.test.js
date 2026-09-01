// Export sensitivity screen. Run: node functions/rag/exportscreen.test.js
//
// Two failure modes are tested with equal weight, because they kill the
// feature in opposite directions:
//
//   • A MISS lets a protected identity walk out in a PDF. Obvious.
//   • A FALSE POSITIVE is just as fatal, only slower. Sentinel's blank CCTNS
//     templates print "Complainant / Informant", "Caste / Tribe" and
//     "Particulars of witnesses" as ordinary field labels. A screen that fires
//     on those flags every FIR, every arrest report and every charge sheet;
//     supervisors then approve without reading, and the control becomes
//     theatre that manufactures the appearance of oversight.
//
// The blank-template fixtures below are copied verbatim from
// react-app/src/data/reportTemplates.js. If someone later widens a term list
// to the bare words, those cases fail here rather than silently in production.
const scr = require('./exportscreen');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const fired = (text, category) =>
  scr.screen(text, { isHtml: false }).reasons.some((r) => r.category === category);

// ── The false-positive suite: real template labels must stay clean ──────────

// Verbatim from reportTemplates.js — the words a naive rule set would flag.
const BLANK_TEMPLATE_LABELS = [
  '6. Complainant / Informant',
  '8. Reasons for delay in reporting by the complainant / informant',
  '14. Signature / Thumb-impression of the complainant / informant',
  'Witnesses examined u/s 180 BNSS (161 CrPC) today',
  '(ix) Caste / Tribe',
  '(h) If released on bail, likely to commit another crime / threaten victims or witnesses',
  'Signature of witness to arrest (family member / respectable local person)',
  '9(a). Name of Complainant / Informant',
  '13. Particulars of witnesses to be examined',
  'Panchas / witnesses to the inquest',
  'Informant — Name & mobile number',
  'Relationship with missing person',
  'Informant address',
  'Signature of the informant',
  '6. Witnesses (panchas)',
];

for (const label of BLANK_TEMPLATE_LABELS) {
  check(
    `blank template label stays clean: "${label.slice(0, 46)}"`,
    !scr.screen(label, { isHtml: false }).needsReview,
    JSON.stringify(scr.screen(label, { isHtml: false }).reasons),
  );
}

check(
  'a whole blank FIR form exports without review',
  !scr.screen(BLANK_TEMPLATE_LABELS.join(' \n '), { isHtml: false }).needsReview,
  JSON.stringify(scr.screen(BLANK_TEMPLATE_LABELS.join(' \n '), { isHtml: false }).reasons),
);

// Ordinary prose that happens to contain a near-miss of a rule term.
const BENIGN_PROSE = [
  'The complainant sustained minor injuries and was discharged the same day.',
  'There was a minor delay in registering the FIR due to jurisdiction.',
  'The juvenile section of the station handled the paperwork.',
  'Grapes and other produce were recovered from the vehicle.',
  'The curtains were draped over the seized goods.',
  'Caste / Tribe: not stated.',
  'Two witnesses were examined and their statements recorded.',
  'The informant was called to the station to sign the complaint.',
  'Theft cases in Mysuru rose 12% quarter on quarter; 47 FIRs, 12 chargesheeted.',
];

for (const line of BENIGN_PROSE) {
  check(
    `benign prose stays clean: "${line.slice(0, 46)}…"`,
    !scr.screen(line, { isHtml: false }).needsReview,
    JSON.stringify(scr.screen(line, { isHtml: false }).reasons),
  );
}

check('"draped" does not fire the rape term', !fired('a cloth draped over it', 'sexual-offence'));
check('"grape" does not fire the rape term', !fired('grape cultivation dispute', 'sexual-offence'));

// ── The catch suite: genuinely sensitive content must be held ───────────────

check('POCSO fires', fired('Charges under the POCSO Act were added.', 'sexual-offence'));
check('sexual assault fires', fired('The victim reported a sexual assault.', 'sexual-offence'));
check('section 376 fires', fired('Section 376 IPC has been invoked.', 'sexual-offence'));
check('minor victim fires', fired('The minor victim was produced before the CWC.', 'minor'));
check('child victim fires', fired('Statement of the child victim recorded.', 'minor'));
check('caste atrocity fires', fired('Registered as a caste atrocity case.', 'caste-communal'));
check('SC/ST Act fires', fired('Booked under the SC/ST Act provisions.', 'caste-communal'));
check('communal tension fires', fired('Communal tension reported in the area.', 'caste-communal'));
check('protected witness fires', fired('A protected witness will depose.', 'protected-source'));
check(
  'confidential informant fires',
  fired('Acting on a confidential informant, the team moved in.', 'protected-source'),
);
check('UAPA fires', fired('UAPA sections were applied.', 'national-security'));
check('sedition fires', fired('A sedition charge is under consideration.', 'national-security'));
check('undercover fires', fired('An undercover officer made the buy.', 'live-operation'));
check('sting operation fires', fired('The sting operation is scheduled for Friday.', 'live-operation'));

// Phrase matching must survive the whitespace that tag-stripping introduces.
check(
  'a phrase broken across lines still matches',
  fired('the victim reported a sexual\n   assault that night', 'sexual-offence'),
);

// Kannada content must be screened too — a Kannada report that bypasses an
// English-only checkpoint is the whole point of having native terms.
check('Kannada: ಅತ್ಯಾಚಾರ fires', fired('ಪ್ರಕರಣ ಅತ್ಯಾಚಾರ ಸಂಬಂಧಿಸಿದೆ', 'sexual-offence'));
check('Kannada: ಜಾತಿ ದೌರ್ಜನ್ಯ fires', fired('ಜಾತಿ ದೌರ್ಜನ್ಯ ಪ್ರಕರಣ ದಾಖಲಾಗಿದೆ', 'caste-communal'));
check('Kannada: ಭಯೋತ್ಪಾದನೆ fires', fired('ಭಯೋತ್ಪಾದನೆ ಪ್ರಕರಣ', 'national-security'));

// ── The density suite: the boring document nobody would flag by eye ────────

const roster = (n) =>
  Array.from({ length: n }, (_, i) => `Accused ${i + 1} — 9${String(800000000 + i).padStart(9, '0')}`).join('\n');

check('four phone numbers is a normal case record', !scr.screen(roster(4), { isHtml: false }).needsReview);
check(
  'forty phone numbers is a contact list',
  fired(roster(40), 'bulk-personal-data'),
  JSON.stringify(scr.screen(roster(40), { isHtml: false }).stats),
);
check(
  'the bulk reason names the count',
  /40 distinct phone numbers/.test(
    scr.screen(roster(40), { isHtml: false }).reasons.map((r) => r.evidence).join(' '),
  ),
);

// Sentinel's own crime numbers are 18 digits. A bare 10-digit scan would find a
// "phone number" inside every one of them and flag any report listing a few
// cases — the exact false positive that would make the density rule useless.
const CRIME_NUMBERS = [
  '144221107202500999', '144221107202500123', '144221107202500456',
  '144221107202500789', '144221107202500321', '144221107202500654',
].join(', ');
check(
  'long crime numbers are not mistaken for phone numbers',
  scr.screen(CRIME_NUMBERS, { isHtml: false }).stats.phones === 0,
  `saw ${scr.screen(CRIME_NUMBERS, { isHtml: false }).stats.phones}`,
);

check(
  'the same number repeated is counted once',
  scr.screen(Array(20).fill('9845011111').join(' '), { isHtml: false }).stats.phones === 1,
);

check(
  'three Aadhaar-format numbers fire',
  fired('2345 6789 0123 / 3456 7890 1234 / 4567 8901 2345', 'bulk-personal-data'),
);

// ── HTML extraction ────────────────────────────────────────────────────────

check(
  'stylesheet text is not screened as content',
  !scr.screen('<style>.rape-red{color:#f00}</style><p>Theft in Mysuru.</p>').needsReview,
);

check(
  'a phrase split by an inline tag still matches',
  scr.screen('<p>the victim reported a sexual <b>assault</b></p>').needsReview,
);

check(
  'tags become boundaries, not word joins',
  !scr.screen('<td>g</td><td>rape</td>').reasons.some((r) => r.evidence === 'grape'),
);

check('entities are decoded before screening', scr.textFromHtml('<p>A&nbsp;&amp;&nbsp;B</p>') === 'A & B');

// ── Fingerprint: an approval authorises ONE document ───────────────────────

const DOC_A = '<p>Report on theft cases in Mysuru.</p>';
const DOC_B = '<p>Report on the protected witness in case 412.</p>';

check('same content, same fingerprint', scr.fingerprint(DOC_A) === scr.fingerprint(DOC_A));
check('different content, different fingerprint', scr.fingerprint(DOC_A) !== scr.fingerprint(DOC_B));
check(
  'markup-only changes do not break an approval',
  scr.fingerprint('<p>Theft in Mysuru.</p>') === scr.fingerprint('<div>  Theft in Mysuru.  </div>'),
);

// ── Degenerate input must not throw or fail open ───────────────────────────

for (const [name, v] of [['null', null], ['undefined', undefined], ['empty', ''], ['number', 42]]) {
  let ok = true;
  try { scr.screen(v); } catch { ok = false; }
  check(`${name} input is handled without throwing`, ok);
}

check('empty document needs no review', !scr.screen('').needsReview);
check('summarise names the categories', scr.summarise(scr.screen('POCSO case')) === 'Sexual offence / POCSO');
check('summarise says so when clean', scr.summarise(scr.screen('Theft in Mysuru')) === 'no sensitive content detected');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
