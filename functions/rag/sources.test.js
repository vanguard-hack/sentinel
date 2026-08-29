// Unified source citation & attribution. Run: node functions/rag/sources.test.js
const a = require('./sources');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

// ── Digitised-record labels ────────────────────────────────────────────────
// A record's title is usually derived from its filename, so naming both would
// print the same words twice.
check('a title taken straight from the filename is not printed twice',
  a.digitisedLabel({ title: 'Patel Public School Road.m4a', filename: 'Patel Public School Road.m4a' })
    === 'Patel Public School Road.m4a');

check('a title matching the filename without its extension is not repeated',
  a.digitisedLabel({ title: 'Patel Public School Road', filename: 'Patel Public School Road.m4a' })
    === 'Patel Public School Road');

check('a renamed record still names the file it came from',
  a.digitisedLabel({ title: 'Statement of complainant', filename: 'rec-0042.m4a' })
    === 'Statement of complainant (rec-0042.m4a)');

check('a record with no title falls back to its filename, once',
  a.digitisedLabel({ title: '', filename: 'scan.jpg' }) === 'scan.jpg');

check('a record with no filename still cites its title',
  a.digitisedLabel({ title: 'Seizure memo', filename: '' }) === 'Seizure memo');

check('surrounding whitespace does not defeat the comparison',
  a.digitisedLabel({ title: '  report.docx  ', filename: 'report.docx' }) === 'report.docx');

check('a dotted filename only loses its final extension',
  a.digitisedLabel({ title: 'FIR.0042.2024', filename: 'FIR.0042.2024.pdf' }) === 'FIR.0042.2024');

check('a missing hit does not throw', typeof a.digitisedLabel(undefined) === 'string');

// ── Knowledge-base chunks ──────────────────────────────────────────────────
const nodes = [
  { document_title: 'SOP_Arrest_and_Impound_v3.pdf', page_label: 12, text: 'Impounded vehicles shall…', score: 0.91 },
  { document_title: 'SOP_Arrest_and_Impound_v3.pdf', page_label: 14, text: 'The seizure memo…', score: 0.77 },
  { metadata: { document_name: 'IPC_Section_Reference.txt', section: '3.2' }, content: 'Section 102…' },
];
const kb = a.fromRagNodes(nodes);
check('chunks from one document fold into a single citation', kb.length === 2);
check('the folded citation keeps every passage', kb[0].passages.length === 2);
check('the first passage sets the cited location', kb[0].location === 'Page 12');
check('a mime type is derived from the filename', kb[0].mime_type === 'application/pdf');
check('metadata is read when the node itself carries nothing',
  kb[1].display_name === 'IPC_Section_Reference.txt' && kb[1].location === 'Section 3.2');
check('a node with no document name is skipped',
  a.fromRagNodes([{ text: 'orphan chunk' }]).length === 0);
check('a RAG answer that named no document still cites the corpus',
  a.knowledgeBaseFallback()[0].display_name === 'Knowledge base');

// ── Data Store ─────────────────────────────────────────────────────────────
const q = "SELECT CaseMasterID, District FROM CaseMaster WHERE District = 'Bengaluru City' AND Year = 2024 ORDER BY CaseMasterID LIMIT 50";
check('the evaluated filter is read off the executed query',
  a.filterSummary(q) === "District = 'Bengaluru City' AND Year = 2024");
check('a query with no WHERE clause reports no filter',
  a.filterSummary('SELECT * FROM CaseMaster LIMIT 10') === null);

const rows = [
  { CaseMasterID: 4029, District: 'Bengaluru City' },
  { CaseMasterID: 4030, District: 'Bengaluru City' },
  { CaseMasterID: 4029, District: 'Bengaluru City' },
];
check('matched record ids come from the primary key, deduped',
  JSON.stringify(a.matchedRecordIds(rows)) === JSON.stringify(['4029', '4030']));
check('an aggregate with no key column cites no record ids',
  a.matchedRecordIds([{ District: 'Mysuru', total: 12 }]).length === 0);

const db = a.fromZcql({ query: q, tables: ['CaseMaster'], rows });
check('a table citation states the read-only execution scope',
  db[0].execution_type === 'Catalyst_DataStore_ZCQL_ReadOnly');
check('the rows travel with the citation so the drawer can show them',
  db[0].records.length === 3);

// ── Vision ─────────────────────────────────────────────────────────────────
const vis = a.fromVision([{
  ok: true, filename: 'Vehicle_Plate_Scan_img01.jpg', doc_type: 'Vehicle document',
  fields: { vehicle_no: 'KA01AB1234', date: '12/03/2024' }, text: 'REGISTRATION CERTIFICATE',
}]);
check('the headline extraction reads as a field and its value',
  vis[0].extracted_field === 'vehicle no: KA01AB1234');
check('the image is identified by its filename', vis[0].identifier === 'Vehicle_Plate_Scan_img01.jpg');
check('the OCR text is carried as the viewable passage',
  vis[0].passages[0].excerpt === 'REGISTRATION CERTIFICATE');

// ── URL allowlisting ───────────────────────────────────────────────────────
check('an allowlisted government URL passes',
  a.isAllowedUrl('https://mha.gov.in/guidelines/vehicle-seizure-protocol'));
check('a subdomain of an allowlisted host passes',
  a.isAllowedUrl('https://cctns.ncrb.gov.in/x'));
// The attack this exists to stop: a hostname that merely CONTAINS an allowed
// one. A substring check would wave it straight through.
check('a lookalike host that only contains an allowed domain is refused',
  !a.isAllowedUrl('https://mha.gov.in.evil.example/phish'));
check('plain http is refused even on an allowed host',
  !a.isAllowedUrl('http://mha.gov.in/x'));
check('an unlisted domain is refused', !a.isAllowedUrl('https://example.com/'));
check('garbage is refused rather than throwing', !a.isAllowedUrl('not a url'));
check('a refused URL produces no citation at all',
  a.fromWeb([{ url: 'https://example.com/', title: 'Anything' }]).length === 0);
check('an allowed URL is cited with its domain',
  a.fromWeb([{ url: 'https://mha.gov.in/g', page_title: 'Guidelines' }])[0].domain === 'mha.gov.in');

// ── Merge & dedupe ─────────────────────────────────────────────────────────
const merged = a.merge(
  a.fromRagNodes([{ document_title: 'SOP.pdf', page_label: 3, text: 'a' }]),
  a.fromRagNodes([{ document_title: 'SOP.pdf', page_label: 9, text: 'b' }]),
  a.fromZcql({ query: q, tables: ['CaseMaster'], rows })
);
check('parallel lanes citing the same document produce one entry', merged.length === 2);
check('the duplicate contributes its passage rather than being dropped',
  merged[0].passages.length === 2);
check('citations are numbered in order',
  merged[0].source_id === 'src_01' && merged[1].source_id === 'src_02');
check('two tables sharing a display name are still distinct citations',
  a.merge(a.fromZcql({ query: "SELECT * FROM A WHERE x = 1", tables: ['A'], rows: [] }),
          a.fromZcql({ query: "SELECT * FROM A WHERE x = 2", tables: ['A'], rows: [] })).length === 2);
check('empty fields are stripped rather than shipped as nulls',
  !('domain' in merged[0]));

// ── Clearance ──────────────────────────────────────────────────────────────
// An analyst works with aggregates: no clearance for case material, and none
// for the identity fields a filter clause can disclose.
const caseDoc = a.merge(a.fromDigitised([{ id: 'rec-1', title: 'Statement of Sunita R', filename: 'rec-1.jpg', excerpt: 'x' }]));
check('an investigator sees the digitised record',
  a.clearanceFilter(caseDoc, 'investigator').sources.length === 1);
check('an analyst is not even told the record exists',
  a.clearanceFilter(caseDoc, 'analyst').sources.length === 0);
check('an unidentified caller is not told either',
  a.clearanceFilter(caseDoc, null).sources.length === 0);

const named = a.merge(a.fromZcql({
  query: "SELECT * FROM CaseMaster WHERE VictimName = 'Sunita R' AND District = 'Mysuru'",
  tables: ['CaseMaster'],
  rows: [{ CaseMasterID: 1, VictimName: 'Sunita R', District: 'Mysuru' }],
}));
const asAnalyst = a.clearanceFilter(named, 'analyst');
check('a filter clause naming a restricted field is removed from the citation',
  asAnalyst.sources[0].filter_applied === "District = 'Mysuru'");
check('the citation says it was redacted rather than looking complete',
  asAnalyst.sources[0].filter_redacted === true);
check('the executed query text goes with it, since it restates the filter',
  !asAnalyst.sources[0].query);
check('the attached rows are redacted too',
  asAnalyst.sources[0].records[0].VictimName === '[redacted]');
check('what was removed is reported for the audit record',
  asAnalyst.removed.includes('VictimName'));
check('an investigator keeps the whole filter',
  a.clearanceFilter(named, 'investigator').sources[0].filter_applied
    === "VictimName = 'Sunita R' AND District = 'Mysuru'");

const plate = a.merge(a.fromVision([{ ok: true, filename: 'x.jpg', fields: { phone: '9876543210' }, text: 'call 9876543210' }]));
check('an identifier in an extracted field is redacted for an analyst',
  /redacted/.test(a.clearanceFilter(plate, 'analyst').sources[0].extracted_field));
check('and in the passage the viewer would show',
  /redacted/.test(a.clearanceFilter(plate, 'analyst').sources[0].passages[0].excerpt));

// ── Audit shaping ──────────────────────────────────────────────────────────
check('the audit line names each citation by id and type',
  a.auditLine(merged).startsWith('src_01:rag_document:SOP.pdf'));
check('the audited array drops the bulky viewer fields',
  a.forAudit(merged).every((s) => !('passages' in s) && !('records' in s)));

console.log(fail ? `\n${fail} FAILED, ${pass} passed.` : `\nAll ${pass} attribution checks passed.`);
process.exit(fail ? 1 : 0);
