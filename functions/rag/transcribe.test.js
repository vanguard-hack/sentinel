// looksDegenerateTranscript(): catches the Whisper-style repetition-loop
// hallucination Zia STT produces when audio is forced through the wrong
// language (no auto-detect on that endpoint).
// translateTranscriptToEnglish(): Zia STT transcribes Hindi/Kannada in the
// spoken script (often code-switched with English loanwords) — it never
// translates. This machine-translates that transcript to English before it
// reaches the composer. Run: node functions/rag/transcribe.test.js

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
const grabFn = (name) => {
  const i = src.indexOf(`async function ${name}(`) >= 0
    ? src.indexOf(`async function ${name}(`)
    : src.indexOf(`function ${name}(`);
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

// eslint-disable-next-line no-new-func
const buildTranslate = () => new Function(
  'callLLM',
  `${grabFn('translateTranscriptToEnglish')}\nreturn translateTranscriptToEnglish;`
);

(async () => {
  const noCall = buildTranslate()(async () => { throw new Error('callLLM should not be called for English'); });
  check('english text is passed through untouched, no LLM call', await noCall('already english', 'en') === 'already english');

  const translateHi = buildTranslate()(async (messages) => {
    check('the source language is named in the translation prompt', messages[1].content.includes('Hindi'));
    return '  The accused fled towards Udupi road.  ';
  });
  check(
    'a Hindi transcript is translated to English and trimmed',
    await translateHi('आरोपी उडुपी रोड की तरफ भाग गया', 'hi') === 'The accused fled towards Udupi road.'
  );

  const translateKn = buildTranslate()(async (messages) => {
    check('Kannada is named in the translation prompt', messages[1].content.includes('Kannada'));
    return 'The suspect escaped.';
  });
  check('a Kannada transcript is translated', await translateKn('ಆರೋಪಿ ಪರಾರಿಯಾಗಿದ್ದಾನೆ', 'kn') === 'The suspect escaped.');

  const translateFail = buildTranslate()(async () => null);
  check(
    'an LLM failure falls back to the original transcript rather than losing it',
    await translateFail('ಆರೋಪಿ ಪರಾರಿಯಾಗಿದ್ದಾನೆ', 'kn') === 'ಆರೋಪಿ ಪರಾರಿಯಾಗಿದ್ದಾನೆ'
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
