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
// Small talk is now the planner's call (plannedCasual); the non-answer check
// is the async model judge, stubbed here.
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
  const start = src.indexOf("const casual = payload.source === 'chat' || plannedCasual;");
  const end = src.indexOf('const shownSources', start);
  const fragment = src.slice(start, src.indexOf('\n', end));
  check('respondWith source rule found in index.js', start > 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const shown = new AsyncFunction('nonAnswer', 'plannedCasual', 'text', 'payload', 'citedSources',
    `${fragment}\nreturn shownSources;`);
  const nonAnswer = async (t) => /couldn'?t find|don'?t have/i.test(t);
  const cites = [{ source_type: 'rag_document', display_name: 'Knowledge base' }];
  (async () => {
    check('greeting answered by the KB shows no source',
      (await shown(nonAnswer, true, 'Hello! I am ready to assist you.', { source: 'rag' }, cites)).length === 0);
    check('chat lane shows no source',
      (await shown(nonAnswer, false, 'Hi!', { source: 'chat' }, cites)).length === 0);
    check('negative answer shows no source',
      (await shown(nonAnswer, false, "I couldn't find that.", { source: 'rag' }, cites)).length === 0);
    check('a real answer keeps its source',
      (await shown(nonAnswer, false, 'Section 41 allows arrest without warrant when…', { source: 'rag' }, cites)).length === 1);
    let judgedCasual = false;
    await shown(async () => { judgedCasual = true; return false; }, true, 'Hi!', { source: 'rag' }, cites);
    check('small talk never spends a judge call', !judgedCasual);
    console.log(failed ? `${failed} failed` : 'All small-talk checks passed.');
    process.exit(failed ? 1 : 0);
  })();
}
