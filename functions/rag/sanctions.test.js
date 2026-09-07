// Sanctions/watchlist lookup: XML parsing against a fixture (not the live
// 2.5MB file, so this suite runs offline and fast) and text matching.
// Run: node functions/rag/sanctions.test.js

const sanctions = require('./sanctions');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// A fixture in the REAL schema, verified directly against the live file
// before this was written (see the design spec) — not guessed at.
const FIXTURE_XML = `<?xml version='1.0' encoding='UTF-8'?>
<CONSOLIDATED_LIST xmlns:xsi='http://www.w3.org/2001/XMLSchema-instance' xsi:noNamespaceSchemaLocation='https://www.un.org/sc/resources/sc-sanctions.xsd' dateGenerated='2026-09-05T23:00:04.811Z'>
    <INDIVIDUALS>
        <INDIVIDUAL>
            <DATAID>110404</DATAID>
            <VERSIONNUM>1</VERSIONNUM>
            <FIRST_NAME>MOHAMMAD BAQER</FIRST_NAME>
            <SECOND_NAME>ZOLQADR</SECOND_NAME>
            <UN_LIST_TYPE>Iran</UN_LIST_TYPE>
            <REFERENCE_NUMBER>IRi.043</REFERENCE_NUMBER>
            <LISTED_ON>2007-03-24</LISTED_ON>
            <COMMENTS1>[Old Reference # I.47.D.7]</COMMENTS1>
            <HAS_INTERPOL_LINK>NO</HAS_INTERPOL_LINK>
            <INTERPOL_LINK/>
            <DESIGNATION>
                <VALUE>General</VALUE>
                <VALUE>IRGC officer</VALUE>
            </DESIGNATION>
            <LIST_TYPE>
                <VALUE>UN List</VALUE>
            </LIST_TYPE>
            <INDIVIDUAL_ALIAS>
                <QUALITY>Good</QUALITY>
                <ALIAS_NAME>Mohammad Bakr Zolqadr</ALIAS_NAME>
            </INDIVIDUAL_ALIAS>
            <INDIVIDUAL_ADDRESS>
                <COUNTRY/>
            </INDIVIDUAL_ADDRESS>
        </INDIVIDUAL>
        <INDIVIDUAL>
            <DATAID>110405</DATAID>
            <FIRST_NAME>MOHAMMAD REZA</FIRST_NAME>
            <SECOND_NAME>ZAHEDI</SECOND_NAME>
            <UN_LIST_TYPE>Iran</UN_LIST_TYPE>
            <REFERENCE_NUMBER>IRi.042</REFERENCE_NUMBER>
            <LISTED_ON>2007-03-24</LISTED_ON>
            <COMMENTS1></COMMENTS1>
            <DESIGNATION>
                <VALUE>Brigadier General</VALUE>
            </DESIGNATION>
        </INDIVIDUAL>
    </INDIVIDUALS>
    <ENTITIES>
        <ENTITY>
            <DATAID>110326</DATAID>
            <FIRST_NAME>YAZD METALLURGY INDUSTRIES (YMI)</FIRST_NAME>
            <UN_LIST_TYPE>Iran</UN_LIST_TYPE>
            <REFERENCE_NUMBER>IRe.078</REFERENCE_NUMBER>
            <LISTED_ON>2010-06-09</LISTED_ON>
            <COMMENTS1>YMI is a subordinate of DIO. [Old Reference #E.29.I.22].</COMMENTS1>
            <ENTITY_ALIAS>
                <QUALITY>a.k.a.</QUALITY>
                <ALIAS_NAME>Yazd Ammunition Manufacturing and Metallurgy Industries</ALIAS_NAME>
            </ENTITY_ALIAS>
        </ENTITY>
    </ENTITIES>
</CONSOLIDATED_LIST>`;

const records = sanctions.parseIndex(FIXTURE_XML);

// ── Parsing ─────────────────────────────────────────────────────────────
check('every fixture record is parsed', records.length === 3);
check("an individual's name is FIRST_NAME + SECOND_NAME",
  records[0].name === 'MOHAMMAD BAQER ZOLQADR');
check('an individual is tagged by kind', records[0].kind === 'individual');
check('an entity is tagged by kind', records.find((r) => r.dataId === '110326').kind === 'entity');
check('the reference number is captured', records[0].referenceNumber === 'IRi.043');
check('the listing date is captured', records[0].listedOn === '2007-03-24');
check('aliases are captured', records[0].aliases.includes('Mohammad Bakr Zolqadr'));
check('a record with no alias still parses with an empty list',
  Array.isArray(records[1].aliases) && records[1].aliases.length === 0);
check('repeated DESIGNATION values are all captured',
  records[0].designation.includes('General') && records[0].designation.includes('IRGC officer'));
check('designation does not pick up unrelated VALUE tags from LIST_TYPE',
  !records[0].designation.includes('UN List'));
check("an entity's single-name field is still read as \"name\"",
  records.find((r) => r.dataId === '110326').name === 'YAZD METALLURGY INDUSTRIES (YMI)');
check("an entity's own alias tag is read, not the individual one",
  records.find((r) => r.dataId === '110326').aliases
    .includes('Yazd Ammunition Manufacturing and Metallurgy Industries'));

// ── Matching ────────────────────────────────────────────────────────────
check('an exact name match is found',
  sanctions.search(records, 'Mohammad Baqer Zolqadr').found);
check('matching is case-insensitive',
  sanctions.search(records, 'mohammad baqer zolqadr').found);
check('punctuation in the query does not defeat the match',
  sanctions.search(records, 'Yazd Metallurgy Industries (YMI)').found);
check('a match on the primary name is labelled as such',
  sanctions.search(records, 'Zolqadr').matches[0].matchedOn === 'name');
check('a match found only in an alias is labelled with that alias',
  /alias: Mohammad Bakr Zolqadr/.test(
    sanctions.search(records, 'Mohammad Bakr Zolqadr').matches[0].matchedOn));
check('word order does not matter, since every query token must simply appear',
  sanctions.search(records, 'Zolqadr Mohammad').found);
check('a name that is not in the list is a clean no-match',
  sanctions.search(records, 'Some Unrelated Person').found === false);
check('an empty query is refused rather than matching everything',
  sanctions.search(records, '').found === false);
check('the cap constant is 10', sanctions.MAX_MATCHES === 10);
check('the true count is reported even when results are capped',
  typeof sanctions.search(records, 'Iran').total === 'number');

// ── Fetch (mocked) ──────────────────────────────────────────────────────
const originalFetch = global.fetch;

(async () => {
  let sawUserAgent = false;
  global.fetch = async (url, opts) => {
    sawUserAgent = !!(opts && opts.headers && opts.headers['User-Agent']);
    return { ok: true, text: async () => FIXTURE_XML };
  };
  const built = await sanctions.buildIndex();
  check('the fetch carries a distinguishing User-Agent', sawUserAgent);
  check('buildIndex fetches and parses in one call', built.records.length === 3);
  check('buildIndex stamps when it ran', typeof built.fetchedAt === 'number' && built.fetchedAt > 0);

  global.fetch = async () => ({ ok: false, status: 403 });
  let threw = false;
  try { await sanctions.buildIndex(); } catch { threw = true; }
  check('a failed fetch throws rather than silently returning an empty index', threw);

  global.fetch = originalFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
