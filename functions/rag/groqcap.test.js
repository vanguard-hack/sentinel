#!/usr/bin/env node
/* callGroq under Groq's per-model daily cap. Run: node functions/rag/groqcap.test.js
 *
 * Each Groq model has its own tokens-per-day allowance. The fast model carries
 * the planner and every query generation, so it runs out first; when it did,
 * every data question failed while the main model's allowance sat unused.
 * The real callGroq is evaluated here against a fake fetch.
 */
const fs = require('fs');

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

const src = fs.readFileSync(__dirname + '/index.js', 'utf8');
const start = src.indexOf('async function callGroq(');
const body = src.slice(start, src.indexOf('\n}\n', start) + 2);

const make = (fakeFetch) => new Function(
  'fetch', 'process', 'GROQ_URL', 'GROQ_MODEL', 'GROQ_MODEL_FAST', 'AbortSignal',
  `${body}; return callGroq;`
)(fakeFetch, { env: { GROQ_API_KEY: 'test' } }, 'https://groq.test', 'main-model', 'fast-model',
  { timeout: () => undefined });

const reply = (status, content, retryAfter) => ({
  status,
  ok: status === 200,
  headers: { get: (h) => (h === 'retry-after' ? retryAfter : null) },
  json: async () => ({ choices: [{ message: { content } }] }),
});

(async () => {
  // Fast model out for the day (a long retry-after); the main model answers.
  const asked = [];
  const capped = make(async (url, init) => {
    const { model } = JSON.parse(init.body);
    asked.push(model);
    return model === 'fast-model' ? reply(429, null, '3600') : reply(200, 'answer from main');
  });
  const out = await capped([{ role: 'user', content: 'q' }], { model: 'fast-model' });
  check('a fast model capped for the day falls over to the main model', out === 'answer from main');
  check('and does so without waiting out an hour-long retry-after', asked.join(',') === 'fast-model,main-model');

  // Both capped: give up after one switch rather than looping.
  let calls = 0;
  const both = make(async () => { calls++; return reply(429, null, '3600'); });
  check('with both models capped it returns null, so the next provider is asked',
    (await both([{ role: 'user', content: 'q' }], { model: 'fast-model' })) === null && calls === 2);

  // A short per-minute cool-off is still waited out once on the same model.
  const seen = [];
  let first = true;
  const brief = make(async (url, init) => {
    seen.push(JSON.parse(init.body).model);
    if (first) { first = false; return reply(429, null, '0.01'); }
    return reply(200, 'after cool-off');
  });
  check('a per-minute cool-off is waited out on the same model',
    (await brief([{ role: 'user', content: 'q' }], { model: 'fast-model' })) === 'after cool-off'
    && seen.join(',') === 'fast-model,fast-model');

  if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
})();
