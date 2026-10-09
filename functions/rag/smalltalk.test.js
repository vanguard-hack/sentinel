// node functions/rag/smalltalk.test.js
const { isSmallTalk } = require('./smalltalk');

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
};

for (const q of [
  'hello there', 'Hi!', 'hey sentinel', 'good morning', 'thanks', 'thank you so much',
  'ok cool', 'how are you?', 'who are you', "what's up", 'bye', 'नमस्ते', 'ನಮಸ್ಕಾರ', 'Hello, how are you doing?',
]) check(`casual: "${q}"`, isSmallTalk(q) === true);

for (const q of [
  'tell cases', 'how many cases in Belagavi', 'hi, how many FIRs today', 'what is section 41',
  'who is the DGP', 'what is it', 'how are cases assigned', 'thanks, now show theft cases',
  'is it going to rain', 'what is your name and rank in the FIR 12/2026', '', 'are you',
]) check(`not casual: "${q}"`, isSmallTalk(q) === false);

// The real source rule from respondWith in index.js, run rather than regexed.
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
  const start = src.indexOf('const groundless = isNegative(text);');
  const end = src.indexOf('const shownSources', start);
  const fragment = src.slice(start, src.indexOf('\n', end));
  check('respondWith source rule found in index.js', start > 0 && end > start);
  const shown = new Function('isNegative', 'isSmallTalk', 'text', 'payload', 'rawQuery', 'citedSources',
    `${fragment}\nreturn shownSources;`);
  const isNegative = (t) => /couldn'?t find|don'?t have/i.test(t);
  const cites = [{ source_type: 'rag_document', display_name: 'Knowledge base' }];
  check('greeting answered by the KB shows no source',
    shown(isNegative, isSmallTalk, 'Hello! I am ready to assist you.', { source: 'rag' }, 'hello there', cites).length === 0);
  check('chat lane shows no source',
    shown(isNegative, isSmallTalk, 'Hi!', { source: 'chat' }, 'yo', cites).length === 0);
  check('negative answer shows no source',
    shown(isNegative, isSmallTalk, "I couldn't find that.", { source: 'rag' }, 'cases in Mysuru', cites).length === 0);
  check('a real answer keeps its source',
    shown(isNegative, isSmallTalk, 'Section 41 allows arrest without warrant when…', { source: 'rag' }, 'what is section 41', cites).length === 1);
}

console.log(failed ? `${failed} failed` : 'All small-talk checks passed.');
process.exit(failed ? 1 : 0);
