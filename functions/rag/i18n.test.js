// Officer-facing strings. Run: node functions/rag/i18n.test.js
//
// The assistant's ANSWER is translated by a model, because its content differs
// every time. Everything in i18n.js is the opposite — fixed text the server
// emits verbatim — and the failure mode for fixed text is not a bad
// translation, it is a MISSING one: an officer working in Kannada gets a
// Kannada answer with an English warning stapled underneath, and the warning
// is the part that most needs to be understood.
//
// So the load-bearing test here is completeness. Every key, in every language,
// every time — asserted as a property, because a table is exactly the kind of
// thing that grows one entry at a time with one language forgotten.
const i18n = require('./i18n');
const grounding = require('./grounding');
const redaction = require('./redaction');
const zcql = require('./zcql');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const DEVA = /[ऀ-ॿ]/;
const KNDA = /[ಀ-೿]/;

// ── Completeness ───────────────────────────────────────────────────────────

const missing = [];
for (const key of i18n.keys()) {
  for (const lang of i18n.LANGS) {
    const v = i18n.STRINGS[key][lang];
    if (!v || !String(v).trim()) missing.push(`${key}:${lang}`);
  }
}
check('every string exists in all three languages', missing.length === 0, missing.join(', '));

const notTranslated = [];
for (const key of i18n.keys()) {
  if (i18n.STRINGS[key].hi === i18n.STRINGS[key].en) notTranslated.push(`${key}:hi`);
  if (i18n.STRINGS[key].kn === i18n.STRINGS[key].en) notTranslated.push(`${key}:kn`);
}
check('no entry was left as a copy of the English', notTranslated.length === 0, notTranslated.join(', '));

const wrongScript = [];
for (const key of i18n.keys()) {
  if (!DEVA.test(i18n.STRINGS[key].hi)) wrongScript.push(`${key}:hi is not Devanagari`);
  if (!KNDA.test(i18n.STRINGS[key].kn)) wrongScript.push(`${key}:kn is not Kannada script`);
}
check('the Hindi is in Devanagari and the Kannada in Kannada script',
  wrongScript.length === 0, wrongScript.join('; '));

// ── Placeholders ───────────────────────────────────────────────────────────
//
// A translation that drops its placeholder produces a sentence with the
// identifier missing — a warning about "does not appear in any record" with no
// record named, which is worse than no warning at all.

const badVars = [];
for (const key of i18n.keys()) {
  const want = [...i18n.STRINGS[key].en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const lang of ['hi', 'kn']) {
    const got = [...i18n.STRINGS[key][lang].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) badVars.push(`${key}:${lang} ${got} vs ${want}`);
  }
}
check('every translation keeps the placeholders the English has',
  badVars.length === 0, badVars.join('; '));

check('a placeholder is filled', /144\/2026/.test(i18n.t('grounding.unsupported.one', 'kn', { ids: '144/2026' })));
check('an unfilled placeholder is left visible rather than blanked',
  /\{ids\}/.test(i18n.t('grounding.unsupported.one', 'kn')),
  'silently dropping it would hide which record was unverified');

// ── Fallback ───────────────────────────────────────────────────────────────

check('an unsupported language falls back to English rather than to the key',
  i18n.t('guard.refusal', 'fr') === i18n.STRINGS['guard.refusal'].en);
check('a missing language falls back too', i18n.t('guard.refusal') === i18n.STRINGS['guard.refusal'].en);
check('an unknown key returns empty, not the key',
  i18n.t('does.not.exist', 'kn') === '',
  'an officer reading "protected.blocked" has not been informed');

// ── The generators actually use it ─────────────────────────────────────────

const unsupported = { grounded: false, unsupported: [{ value: '999/2026', kind: 'crime_number' }], contradiction: false };
check('a grounding warning comes back in Kannada', KNDA.test(grounding.warning(unsupported, 'kn')));
check('  and in Hindi', DEVA.test(grounding.warning(unsupported, 'hi')));
check('  and in English by default', /does not appear/.test(grounding.warning(unsupported)));
check('  with the identifier untranslated in every language',
  i18n.LANGS.every((l) => grounding.warning(unsupported, l).includes('999/2026')),
  'a crime number is a key into another system, not a word');

const twoIds = { grounded: false, contradiction: false, unsupported: [
  { value: '1/2026', kind: 'crime_number' }, { value: '2/2026', kind: 'crime_number' },
] };
check('plural and singular are separate entries, not a suffix',
  grounding.warning(twoIds, 'kn') !== grounding.warning(unsupported, 'kn'));

const sections = { grounded: false, contradiction: false, unsupported: [{ value: 'IPC 511', kind: 'legal_section' }] };
check('an unknown section warning is localised', KNDA.test(grounding.warning(sections, 'kn')));
check('  and still names the section', grounding.warning(sections, 'kn').includes('IPC 511'));

const contra = { grounded: false, unsupported: [], contradiction: true, retrieved_rows: 3 };
check('the contradiction warning is localised', DEVA.test(grounding.warning(contra, 'hi')));
check('  and carries the row count', grounding.warning(contra, 'hi').includes('3'));

check('the protected-identity notice is localised',
  KNDA.test(redaction.protectedNotice({ fieldsWithheld: 1, cleared: true }, 'kn')));
check('  in both the blocked and the unlockable form',
  KNDA.test(redaction.protectedNotice({ fieldsWithheld: 1, cleared: false }, 'kn'))
  && redaction.protectedNotice({ fieldsWithheld: 1, cleared: false }, 'kn')
     !== redaction.protectedNotice({ fieldsWithheld: 1, cleared: true }, 'kn'));
check('  and still cites the sections in Latin',
  redaction.protectedNotice({ fieldsWithheld: 1, cleared: true }, 'kn').includes('POCSO'));
check('nothing is returned when nothing was withheld',
  redaction.protectedNotice({ fieldsWithheld: 0 }, 'kn') === null);

const rows = [{ District: 'Mysuru', Cases: 12 }, { District: 'Hubli', Cases: 7 }];
const titles = (l) => zcql.rowsToComponents(rows, undefined, l).map((c) => c.title);
check('component titles are localised', titles('kn').every((t) => KNDA.test(t)), JSON.stringify(titles('kn')));
check('  and keep the database column name untranslated',
  titles('kn').some((t) => t.includes('Cases')),
  'a heading an officer can match against the field they know beats one that reads smoothly');
check('  with English unchanged', titles('en').includes('District figures'));

// ── Every string reaches the officer in their language ─────────────────────
//
// Asserted against the source: the notices are assembled in one place, and a
// new one added without a language argument would silently ship English.
const src = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
for (const [what, re] of [
  ['the grounding warning', /grounding\.warning\(groundingResult, responseLang\)/],
  ['the protected notice', /redaction\.protectedNotice\(withheldReach, responseLang\)/],
  ['the attachment warning', /i18n\.t\('attachment\.injection', responseLang\)/],
  ['the guardrail refusal', /i18n\.t\('guard\.refusal', responseLang\)/],
  ['the answer itself', /finalAnswer\(text, responseLang\)/],
  ['table components', /rowsToComponents\(flat, undefined, responseLang\)/],
]) {
  check(`${what} is emitted in the officer's language`, re.test(src));
}

// ── Honest reporting of what was delivered ────────────────────────────────
//
// localiseAnswer falls back to English when the model call fails, which is
// right — an English answer beats no answer. Reporting response_lang: 'kn'
// alongside it is not: the client acts on that field, and the officer is left
// wondering why the interface changed languages on them.
check('the response reports the language actually delivered, not the one asked for',
  /response_lang: deliveredLang \|\| responseLang/.test(src));
check('  and says so when localisation was unavailable',
  /localisation: 'unavailable'/.test(src));
check('  decided by the script in the text, not by what was requested',
  /SCRIPT\[lang\] && !SCRIPT\[lang\]\.test\(localised\)/.test(src));
check('  and an identifier-only answer is not mistaken for a failed translation',
  /\/\[A-Za-z\]\{4\}\/\.test\(localised\)/.test(src),
  'an answer that is mostly crime numbers has nothing to translate');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
