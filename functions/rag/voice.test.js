// Voice mode: picking the spoken language out of three forced transcripts,
// and cleaning an answer before it is read aloud.
// Run: node functions/rag/voice.test.js

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name); }
};

const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
const block = src.slice(src.indexOf('const VOICE_PICK_SYSTEM'), src.indexOf('async function handleVoiceSpeak'));
const SCRIPT = { hi: /[ऀ-ॿ]/, kn: /[ಀ-೿]/ };

// The real functions, with callLLM swapped for a stub per case.
const load = (llm) =>
  // eslint-disable-next-line no-new-func
  new Function('callLLM', 'SCRIPT', `${block}; return { pickSpokenLanguage, speakableText };`)(llm, SCRIPT);

(async () => {
  // English alone needs no model call.
  let called = false;
  const en = await load(async () => { called = true; return ''; }).pickSpokenLanguage({ en: 'how many cases in Mysuru' });
  check('english-only skips the model', !called && en.lang === 'en' && en.english === 'how many cases in Mysuru');

  // The model's pick and translation are used when valid.
  const picked = await load(async () => '{"lang":"kn","english":"How many thefts in Mysuru?"}')
    .pickSpokenLanguage({ en: 'my sure kalla', hi: 'मैसूर', kn: 'ಮೈಸೂರಿನಲ್ಲಿ ಎಷ್ಟು ಕಳ್ಳತನ?' });
  check('model pick is used', picked.lang === 'kn' && picked.english === 'How many thefts in Mysuru?');
  check('original is the chosen transcript', picked.original === 'ಮೈಸೂರಿನಲ್ಲಿ ಎಷ್ಟು ಕಳ್ಳತನ?');

  // A model naming a language that produced no transcript is not trusted.
  const bogus = await load(async () => '{"lang":"hi","english":"x"}').pickSpokenLanguage({ en: 'hello there', kn: 'ಹಲೋ' });
  check('a pick with no transcript falls back', bogus.lang === 'kn');

  // No model: native script decides.
  const noModel = await load(async () => { throw new Error('down'); })
    .pickSpokenLanguage({ en: 'kitne case', hi: 'कितने केस हैं', kn: 'kitne' });
  check('without a model, native script decides', noModel.lang === 'hi' && noModel.english === 'कितने केस हैं');

  const { speakableText } = load(async () => '');
  check('markdown and citations are stripped',
    speakableText('**Three** cases [1] in *Mysuru*. See [the map](https://x.y/z).') === 'Three cases in Mysuru. See the map.');
  check('code blocks are not read aloud', !/agui|components/.test(speakableText('Done.\n```agui\n{"components":[]}\n```')));
  check('list bullets are dropped', speakableText('- one\n- two') === 'one two');
  const long = speakableText('This is a sentence. '.repeat(120));
  check('long answers are cut at a sentence', long.length < 1300 && /The rest is on screen\.$/.test(long));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
