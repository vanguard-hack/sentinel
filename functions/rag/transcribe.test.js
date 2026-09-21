// looksDegenerateTranscript(): catches the Whisper-style repetition-loop
// hallucination Zia STT produces when audio is forced through the wrong
// language (no auto-detect on that endpoint). Run: node functions/rag/transcribe.test.js

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
const grabFn = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('missing function ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
};

// eslint-disable-next-line no-new-func
const looksDegenerateTranscript = new Function(`${grabFn('looksDegenerateTranscript')}\nreturn looksDegenerateTranscript;`)();

check('short transcript never flagged', looksDegenerateTranscript('the accused fled towards udupi road') === false);
check('empty transcript never flagged', looksDegenerateTranscript('') === false);
check(
  'a real, varied long sentence is not flagged',
  looksDegenerateTranscript(
    'the investigating officer recorded a statement from the witness near the bus stand ' +
    'at approximately nine in the evening on the fourteenth of march'
  ) === false
);
check(
  'a runaway repetition loop is flagged',
  looksDegenerateTranscript(Array(30).fill('the one who is the one who is').join(' ')) === true
);
check(
  'a phrase repeated a handful of times (natural emphasis) is not flagged',
  looksDegenerateTranscript(
    'no sir no sir I did not see him there I was at home the whole night no sir I am telling the truth ' +
    'officer please believe me I was not there at all that night'
  ) === false
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
