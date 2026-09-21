// looksDegenerateTranscript(): catches the Whisper-style repetition-loop
// hallucination Zia STT produces when audio is forced through the wrong
// language (no auto-detect on that endpoint).
// transliterateToNativeScript(): Zia STT sometimes renders Hindi/Kannada
// speech in Latin letters ("han bhai mera naam...") instead of native script.
// That's indistinguishable from English to every downstream language check,
// so this rewrites it into native Devanagari/Kannada script (same words, no
// translation) before it reaches the composer. Run: node functions/rag/transcribe.test.js

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

// Same literal ranges as index.js's own SCRIPT/LANG_NAME — injected as
// dependencies, same pattern geolocate.test.js uses for fetch/AbortSignal.
const SCRIPT = { hi: /[ऀ-ॿ]/, kn: /[ಀ-೿]/ };
const LANG_NAME = { en: 'English', hi: 'Hindi', kn: 'Kannada' };

// eslint-disable-next-line no-new-func
const buildTransliterate = () => new Function(
  'callLLM', 'SCRIPT', 'LANG_NAME',
  `${grabFn('transliterateToNativeScript')}\nreturn transliterateToNativeScript;`
);

(async () => {
  const noCallEn = buildTransliterate()(async () => { throw new Error('callLLM should not be called for English'); }, SCRIPT, LANG_NAME);
  check('english text is passed through untouched, no LLM call', await noCallEn('already english', 'en') === 'already english');

  const noCallAlreadyDevanagari = buildTransliterate()(
    async () => { throw new Error('callLLM should not be called when script is already native'); }, SCRIPT, LANG_NAME
  );
  check(
    'a transcript already in Devanagari is passed through untouched, no LLM call',
    await noCallAlreadyDevanagari('आरोपी उडुपी रोड की तरफ भाग गया', 'hi') === 'आरोपी उडुपी रोड की तरफ भाग गया'
  );

  const romanHi = buildTransliterate()(async (messages) => {
    check('Hindi is named in the transliteration prompt', messages[0].content.includes('Hindi'));
    return '  आरोपी उडुपी रोड की तरफ भाग गया  ';
  }, SCRIPT, LANG_NAME);
  check(
    'Romanized Hindi is rewritten into Devanagari and trimmed',
    await romanHi('aaropi udupi road ki taraf bhaag gaya', 'hi') === 'आरोपी उडुपी रोड की तरफ भाग गया'
  );

  const romanKn = buildTransliterate()(async (messages) => {
    check('Kannada is named in the transliteration prompt', messages[0].content.includes('Kannada'));
    return 'ಆರೋಪಿ ಪರಾರಿಯಾಗಿದ್ದಾನೆ';
  }, SCRIPT, LANG_NAME);
  check(
    'Romanized Kannada is rewritten into Kannada script',
    await romanKn('aaropi pararaayaagiddaane', 'kn') === 'ಆರೋಪಿ ಪರಾರಿಯಾಗಿದ್ದಾನೆ'
  );

  const llmFails = buildTransliterate()(async () => null, SCRIPT, LANG_NAME);
  check(
    'an LLM failure falls back to the Romanized transcript rather than losing it',
    await llmFails('aaropi pararaayaagiddaane', 'kn') === 'aaropi pararaayaagiddaane'
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
