// Every API path is absolute.
//
// The Investigation Diary's delete button never once deleted anything. It
// posted to 'investigation/remove' — no leading slash — which the browser
// resolves against the CURRENT page, so from /app/investigation-diary it asked
// the static host for /app/investigation/remove. Catalyst answers unknown
// client routes with the SPA's own 404.html, so the request "succeeded" as an
// HTML 404, the officer read "HTTP 404", and the diary stayed put.
//
// Nothing else catches this: it is one missing character, the code reads
// correctly, and a unit test that mocks fetch never sees where the request
// actually went. So the assertion is on the source.
//
// The check has to know which helpers FORWARD the path and which PREFIX it —
// actionQueue.js posts to 'investigation/actions' and is perfectly correct,
// because its own helper wraps it in `/server/rag/${url}`. Only a file whose
// helper hands the string straight to fetch is bound by this rule.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'utils');
const FORWARDS = /fetch\(\s*url\b/;                       // fetch(url, {...})
const CALL = /\b(?:fetch|post)\(\s*(['"])([^'"`\n]+)\1/g;

// Absolute paths, full URLs and data/blob URIs are all fine. A string with no
// slash is not a path at all.
const suspect = (url) => url.includes('/') && !url.startsWith('/') && !/^[a-z]+:/i.test(url);

test('no API call is a relative path', () => {
  const offences = [];
  for (const file of fs.readdirSync(DIR).filter((f) => /\.(js|ts)$/.test(f))) {
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    const forwards = FORWARDS.test(src);
    for (const m of src.matchAll(CALL)) {
      const [, , url] = m;
      // A bare fetch() is always the real request; a post() only matters where
      // the helper forwards what it is given.
      if (!forwards && !m[0].startsWith('fetch')) continue;
      if (!suspect(url)) continue;
      offences.push(`${file}:${src.slice(0, m.index).split('\n').length} -> ${url}`);
    }
  }
  expect(offences).toEqual([]);
});

test('the check would have caught the bug it exists for', () => {
  const src = "async function post(url){return fetch(url,{});}\npost('investigation/remove', x);";
  const forwards = FORWARDS.test(src);
  const hits = [...src.matchAll(CALL)].filter((m) => (forwards || m[0].startsWith('fetch')) && suspect(m[2]));
  expect(hits.map((m) => m[2])).toEqual(['investigation/remove']);
});
