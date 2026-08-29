// Fast Vision Pre-Parser checks. Run: node functions/rag/vision.test.js
const vision = require('./vision');
const redaction = require('./redaction');

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : (fail++, console.log('FAIL ' + name)); if (cond) console.log('ok  ' + name); };

// ── Document classification ───────────────────────────────────────────────
check('an FIR is recognised from its statutory heading',
  vision.classify('FIRST INFORMATION REPORT u/s 154 Cr.P.C.') === 'FIR');
check('a seizure memo is recognised',
  vision.classify('SEIZURE MEMO / PANCHNAMA drawn at the scene') === 'Seizure memo');
check('a post-mortem report is recognised',
  vision.classify('POST-MORTEM examination — cause of death') === 'Post-mortem report');
check('an FIR mentioning a seizure is still an FIR, not a seizure memo',
  vision.classify('First Information Report ... articles recovered from the accused') === 'FIR');
check('unrecognised paper is left unclassified rather than guessed at',
  vision.classify('Dear Sir, please find enclosed the office memo.') === null);

// ── Field extraction ──────────────────────────────────────────────────────
const f = vision.extractFields(
  'Cr. No. 0042/2024  P.S. Ashok Nagar,\nU/S 379 IPC  Date: 14/03/2024  Vehicle KA 05 MJ 2841'
);
check('the crime number is pulled out', f.crime_no === '0042/2024');
check('the section is pulled out', /379/.test(f.section || ''));
check('the police station is pulled out', /Ashok Nagar/.test(f.police_station || ''));
check('the date is pulled out', f.date === '14/03/2024');
check('the vehicle number is pulled out', f.vehicle_no === 'KA 05 MJ 2841');
check('nothing is invented when a field is absent',
  vision.extractFields('illegible scan').crime_no === undefined);

// ── Object filtering ──────────────────────────────────────────────────────
const objs = vision.summariseObjects({ objects: [
  { object_type: 'person', confidence: '0.93' },
  { object_type: 'person', confidence: '0.88' },
  { object_type: 'car', confidence: '0.71' },
  { object_type: 'knife', confidence: '0.42' },   // too unsure to assert
  { object_type: 'potted plant', confidence: '0.99' }, // not investigative
] });
check('repeated detections are counted, not listed', objs.includes('2 persons'));
check('a confident single detection survives', objs.includes('car'));
check('a low-confidence weapon is NOT asserted', !objs.some((o) => /knife/.test(o)));
check('irrelevant scenery is dropped', !objs.some((o) => /plant/.test(o)));
check('an empty detection set yields nothing',
  vision.summariseObjects({ objects: [] }).length === 0);
check('a failed vision service does not crash the digest',
  vision.summariseObjects(null).length === 0);

// ── Prompt rendering ──────────────────────────────────────────────────────
const digest = {
  filename: 'fir.jpg', ok: true, doc_type: 'FIR',
  fields: { crime_no: '0042/2024' }, objects: ['car'], barcode: null,
  graphic: null, text: 'Complainant states his motorcycle was stolen.', notes: [],
};
const prompt = vision.digestToPrompt(digest);
check('the prompt names the document type', /Looks like: FIR/.test(prompt));
check('the prompt carries the extracted fields', /crime no: 0042\/2024/.test(prompt));
check('the prompt carries the OCR text', /motorcycle was stolen/.test(prompt));
check('an unreadable image says so plainly',
  /could not be read/.test(vision.digestToPrompt({ filename: 'x.jpg', ok: false })));
check('an image with no text says so rather than staying silent',
  /No readable text/.test(vision.digestToPrompt({ ...digest, text: '' })));
check('a graphic flag is advisory, not a refusal',
  /answer with appropriate care/.test(vision.digestToPrompt({ ...digest, graphic: 'violence' })));
check('a partial read is disclosed',
  /Partial read/.test(vision.digestToPrompt({ ...digest, notes: ['objects unavailable'] })));

// ── The digest is prompt-bound text, so redaction must reach it ───────────
const scanned = 'Complainant Ravi, mobile 9845012345, Aadhaar 2345 6789 0123.';
const filtered = redaction.filterText(scanned, 'analyst');
const safePrompt = vision.digestToPrompt({ ...digest, text: filtered.text });
check('an identifier read off a scan does not reach the prompt',
  !/9845012345/.test(safePrompt) && !/2345 6789 0123/.test(safePrompt));
check('the redaction is visible to the model, not silently blank',
  /\[phone redacted\]/.test(safePrompt));
check('an investigator still sees the scanned contact detail',
  /9845012345/.test(vision.digestToPrompt({
    ...digest, text: redaction.filterText(scanned, 'investigator').text })));

console.log(fail ? `\n${fail} FAILED, ${pass} passed.` : `\nAll ${pass} vision checks passed.`);
process.exit(fail ? 1 : 0);
