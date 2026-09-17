// PII detection/anonymization core. Run: node functions/rag/anonymize.test.js
const anonymize = require('./anonymize');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// Locates a substring by value instead of hand-counted indices, so a typo in
// the fixture text can't silently desync the expected span.
const span = (text, value, from = 0) => {
  const start = text.indexOf(value, from);
  if (start < 0) throw new Error(`fixture bug: "${value}" not found in "${text}"`);
  return { start, end: start + value.length, text: value };
};

// ── Regex recognizers ───────────────────────────────────────────────────────
{
  const text = 'FIR 42/2026 was registered on 04/03/2026 after a call from 9876543210.';
  const hits = anonymize.regexEntities(text);
  const firHit = hits.find((h) => h.type === 'FIR_NUMBER');
  check('FIR number is recognised', !!firHit && firHit.text === '42/2026');
  const dateHit = hits.find((h) => h.type === 'DATE');
  check('DD/MM/YYYY date is recognised', !!dateHit && dateHit.text === '04/03/2026');
  const phoneHit = hits.find((h) => h.type === 'PHONE');
  check('10-digit Indian mobile number is recognised', !!phoneHit && phoneHit.text === '9876543210');
  check('every regex hit carries the matched span exactly',
    hits.every((h) => text.slice(h.start, h.end) === h.text));
}

// ── Overlap resolution ──────────────────────────────────────────────────────
{
  const text = 'Ravi Kumar was seen near Chennai.';
  const shortHit = { type: 'PERSON', ...span(text, 'Ravi Kuma'), score: 0.6 };
  const longHit = { type: 'PERSON', ...span(text, 'Ravi Kumar'), score: 0.9 };
  const locHit = { type: 'LOCATION', ...span(text, 'Chennai'), score: 0.8 };
  const kept = anonymize.resolveOverlaps([shortHit, longHit, locHit]);
  check('the higher-scoring entity wins an overlap',
    kept.length === 2 && kept[0].text === 'Ravi Kumar');
  check('non-overlapping entities all survive', kept.some((e) => e.text === 'Chennai'));
  check('kept entities are sorted by start position',
    kept.every((e, i) => i === 0 || kept[i - 1].start <= e.start));
}

// ── Consistent placeholders ─────────────────────────────────────────────────
{
  const text = 'Ravi Kumar met Ravi Kumar near Chennai.';
  const first = span(text, 'Ravi Kumar');
  const second = span(text, 'Ravi Kumar', first.end);
  const loc = span(text, 'Chennai');
  const entities = [
    { type: 'PERSON', ...first, score: 1 },
    { type: 'PERSON', ...second, score: 1 },
    { type: 'LOCATION', ...loc, score: 1 },
  ];
  const { anonymizedText, entityMap, entityCounts } = anonymize.anonymizeText(text, entities);
  check('the same value gets the same placeholder',
    anonymizedText === 'PERSON_0 met PERSON_0 near LOCATION_0.');
  check('entityMap records the mapping for reveal', entityMap.PERSON['Ravi Kumar'] === 'PERSON_0');
  check('entityCounts reflects distinct values per type',
    entityCounts.PERSON === 1 && entityCounts.LOCATION === 1);
}

// ── Reveal roundtrip ─────────────────────────────────────────────────────────
{
  const text = 'Ravi Kumar met Suresh near Chennai.';
  const entities = [
    { type: 'PERSON', ...span(text, 'Ravi Kumar'), score: 1 },
    { type: 'PERSON', ...span(text, 'Suresh'), score: 1 },
    { type: 'LOCATION', ...span(text, 'Chennai'), score: 1 },
  ];
  const { anonymizedText, entityMap } = anonymize.anonymizeText(text, entities);
  check('reveal reproduces the original text exactly',
    anonymize.revealText(anonymizedText, entityMap) === text);

  const thirdPartyReport = `Case summary: ${anonymizedText} Filed under review.`;
  const revealedReport = anonymize.revealText(thirdPartyReport, entityMap);
  check('reveal also works on a third-party document built from the anonymized text',
    revealedReport === `Case summary: ${text} Filed under review.`);
}

// ── Reveal with 11+ distinct entities (placeholder substring collision) ──────
{
  const text = 'A met B met C met D met E met F met G met H met I met J met K met L.';
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  const entities = names.map((name) => ({
    type: 'PERSON', ...span(text, name), score: 1,
  }));
  const { anonymizedText, entityMap } = anonymize.anonymizeText(text, entities);
  // Placeholders will be PERSON_0 through PERSON_11; naive split('PERSON_1').join(...)
  // would corrupt PERSON_10 and PERSON_11. Word-boundary regex prevents this.
  check('reveal is faithful with 11+ distinct values (no substring collision of PERSON_1 into PERSON_10)',
    anonymize.revealText(anonymizedText, entityMap) === text);
}

// ── NER integration (injectable — no live Zia call) ─────────────────────────
{
  (async () => {
    const text = 'John works at Zoho in Chennai';
    const johnSpan = span(text, 'John');
    const chennaiSpan = span(text, 'Chennai');
    const zohoSpan = span(text, 'Zoho');
    const fakeNer = async () => [{
      ner: { general_entities: [
        { start_index: johnSpan.start, end_index: johnSpan.end - 1, confidence_score: '0.95', ner_tag: 'PERSON', token: 'John' },
        { start_index: chennaiSpan.start, end_index: chennaiSpan.end - 1, confidence_score: '0.9', ner_tag: 'LOCATION', token: 'Chennai' },
        // Deliberately wrong offset (does not point at its own token) — must
        // be dropped, not spliced in and corrupt the text.
        { start_index: zohoSpan.start + 1, end_index: zohoSpan.end, confidence_score: '0.4', ner_tag: 'ORG', token: 'Zoho' },
      ] },
    }];
    const { entities, available } = await anonymize.nerEntities(text, fakeNer);
    check('NER wrapper is available when the injected call succeeds', available === true);
    check('a correctly-offset entity is kept',
      entities.some((e) => e.text === 'John' && e.type === 'PERSON'));
    check('a mis-offset entity is dropped rather than corrupting a later splice',
      !entities.some((e) => e.text === 'Zoho'));

    const failingNer = async () => { throw new Error('quota exceeded'); };
    const degraded = await anonymize.nerEntities(text, failingNer);
    check('a failing NER call degrades to unavailable rather than throwing',
      degraded.available === false && degraded.entities.length === 0);

    const mergeText = 'FIR 9/2026 says John met Chennai.';
    const mergeJohn = span(mergeText, 'John');
    const full = await anonymize.detectAndAnonymize(mergeText, async () => [{
      ner: { general_entities: [
        { start_index: mergeJohn.start, end_index: mergeJohn.end - 1, confidence_score: '0.95', ner_tag: 'PERSON', token: 'John' },
      ] },
    }]);
    check('detectAndAnonymize merges regex and NER hits',
      full.anonymizedText === 'FIR FIR_NUMBER_0 says PERSON_0 met Chennai.');
    check('detectAndAnonymize reports NER availability', full.nerAvailable === true);

    // Test that regex hits always beat NER hits even if NER returns very high
    // confidence scores (e.g., on 0-100 scale rather than 0-1). Regex score is
    // fixed at 1, and NER is clamped to 0.99, so regex must always win overlaps.
    const highConfText = 'FIR 42/2026 was filed.';
    const firSpan = span(highConfText, '42/2026');
    const nerWithHighScore = async () => [{
      ner: { general_entities: [
        // High confidence that looks like 0-100 scale (99) — simulates the real bug
        { start_index: firSpan.start, end_index: firSpan.end - 1, confidence_score: '99', ner_tag: 'NUMBER', token: '42/2026' },
      ] },
    }];
    const highConfResult = await anonymize.detectAndAnonymize(highConfText, nerWithHighScore);
    check('regex hit (FIR_NUMBER, score 1) beats high-confidence NER (NUMBER, clamped to 0.99)',
      highConfResult.anonymizedText === 'FIR FIR_NUMBER_0 was filed.');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}
