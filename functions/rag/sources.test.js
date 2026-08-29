// Citation formatting. Run: node functions/rag/sources.test.js
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/index.js', 'utf8');
const i = src.indexOf('function digitisedSourceLabel(');
let d = 0, body = '';
for (let k = src.indexOf('{', i); k < src.length; k++) {
  if (src[k] === '{') d++;
  else if (src[k] === '}' && --d === 0) { body = src.slice(i, k + 1); break; }
}
// eslint-disable-next-line no-new-func
const digitisedSourceLabel = new Function(body + '\nreturn digitisedSourceLabel;')();

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : (fail++, console.log('FAIL ' + name)); if (cond) console.log('ok  ' + name); };

check('a title taken straight from the filename is not printed twice',
  digitisedSourceLabel({ title: 'Patel Public School Road.m4a', filename: 'Patel Public School Road.m4a' })
    === 'Digitised record: Patel Public School Road.m4a');

check('a title matching the filename without its extension is not repeated',
  digitisedSourceLabel({ title: 'Patel Public School Road', filename: 'Patel Public School Road.m4a' })
    === 'Digitised record: Patel Public School Road');

check('a renamed record still names the file it came from',
  digitisedSourceLabel({ title: 'Statement of complainant', filename: 'rec-0042.m4a' })
    === 'Digitised record: Statement of complainant (rec-0042.m4a)');

check('a record with no title falls back to its filename, once',
  digitisedSourceLabel({ title: '', filename: 'scan.jpg' })
    === 'Digitised record: scan.jpg');

check('a record with no filename still cites its title',
  digitisedSourceLabel({ title: 'Seizure memo', filename: '' })
    === 'Digitised record: Seizure memo');

check('surrounding whitespace does not defeat the comparison',
  digitisedSourceLabel({ title: '  report.docx  ', filename: 'report.docx' })
    === 'Digitised record: report.docx');

check('a dotted filename only loses its final extension',
  digitisedSourceLabel({ title: 'FIR.0042.2024', filename: 'FIR.0042.2024.pdf' })
    === 'Digitised record: FIR.0042.2024');

check('a missing hit does not throw', typeof digitisedSourceLabel(undefined) === 'string');

console.log(fail ? `\n${fail} FAILED, ${pass} passed.` : `\nAll ${pass} citation checks passed.`);
process.exit(fail ? 1 : 0);
