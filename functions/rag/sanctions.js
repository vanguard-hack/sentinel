'use strict';

// Sanctions/watchlist lookup — the UN Security Council Consolidated List,
// text-matched against a name an officer is checking. Unlike osint.js, this
// is NOT a live per-query call: the source changes once a day, not once a
// question, so a 2.5MB fetch-and-parse on every assistant turn would spend
// real time out of the tool budget for no reason. This module deliberately
// knows nothing about Stratus or caching — index.js's runToolLoop owns the
// cache read/write, the same separation forecast.js already draws between
// building a fresh bundle and handleForecast caching it. A pure function is
// easier to test and to reason about than one that also knows where its own
// cache lives.
//
// Source verified directly against the live file before any of this was
// written: https://unsolprodfiles.blob.core.windows.net/publiclegacyxmlfiles/EN/consolidated.xml
// — 2.5MB, updated daily, 736 <INDIVIDUAL> + 275 <ENTITY> records under one
// <CONSOLIDATED_LIST> root. Its edge blocks requests with no distinguishing
// User-Agent, the same way rdap.org does, so every fetch here carries one.

const SOURCE_URL = 'https://unsolprodfiles.blob.core.windows.net/publiclegacyxmlfiles/EN/consolidated.xml';
const USER_AGENT = 'Sentinel-Sanctions/1.0 (Karnataka State Police crime platform)';
const FETCH_TIMEOUT_MS = 20_000;

// The index is rebuilt once it is older than this. The source itself
// updates daily; checking more often would only ever re-fetch the same
// file.
const STALE_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = 'sanctions/index-v1.json';
const MAX_MATCHES = 10;

// ── Fetch ────────────────────────────────────────────────────────────────

async function fetchXml() {
  const res = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`sanctions list fetch failed: HTTP ${res.status}`);
  return res.text();
}

// ── Parse ────────────────────────────────────────────────────────────────
//
// A hand-rolled, deliberately narrow parser rather than a full XML library:
// the real schema (verified directly against the live file) is flat enough
// that pulling out the handful of fields this tool needs is a handful of
// regexes, not a DOM. Anything the schema adds later that this does not
// read is simply not surfaced — never guessed at.

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// The first (and for these tags, only) match of <TAG>...</TAG> in a block.
function textOf(block, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
  return m ? decodeEntities(m[1].trim()) : '';
}

// Same, but the raw inner text is returned unescaped — used to scope a
// search to inside one sub-element (e.g. DESIGNATION) before pulling its
// own repeated children, so a sibling element's same-named children (e.g.
// LIST_TYPE's own <VALUE>) are never picked up by accident.
function subBlock(block, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
  return m ? m[1] : '';
}

// Every match of <TAG>...</TAG> in a block, in order.
function allOf(block, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(decodeEntities(m[1].trim()));
  return out;
}

function aliasesOf(block, wrapTag) {
  const re = new RegExp(`<${wrapTag}>([\\s\\S]*?)<\\/${wrapTag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(block))) {
    const name = textOf(m[1], 'ALIAS_NAME');
    if (name) out.push(name);
  }
  return out;
}

function parseRecord(block, kind) {
  const first = textOf(block, 'FIRST_NAME');
  const second = textOf(block, 'SECOND_NAME');
  const third = textOf(block, 'THIRD_NAME');
  const name = [first, second, third].filter(Boolean).join(' ');
  const aliasTag = kind === 'individual' ? 'INDIVIDUAL_ALIAS' : 'ENTITY_ALIAS';
  // Scoped to inside <DESIGNATION> specifically — the same block also
  // contains <LIST_TYPE><VALUE>UN List</VALUE></LIST_TYPE>, and a bare
  // allOf(block, 'VALUE') over the WHOLE record would silently fold that
  // in as if it were a designation.
  const designation = allOf(subBlock(block, 'DESIGNATION'), 'VALUE')
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 6);
  return {
    kind,
    dataId: textOf(block, 'DATAID'),
    name,
    aliases: aliasesOf(block, aliasTag),
    referenceNumber: textOf(block, 'REFERENCE_NUMBER'),
    listType: textOf(block, 'UN_LIST_TYPE'),
    listedOn: textOf(block, 'LISTED_ON'),
    comments: textOf(block, 'COMMENTS1'),
    designation,
  };
}

function blocksOf(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/**
 * Parse the Consolidated List's raw XML into a flat, search-ready index.
 * A record missing an optional field still gets indexed on what it has.
 */
function parseIndex(xml) {
  const individuals = blocksOf(xml, 'INDIVIDUAL').map((b) => parseRecord(b, 'individual'));
  const entities = blocksOf(xml, 'ENTITY').map((b) => parseRecord(b, 'entity'));
  return [...individuals, ...entities].filter((r) => r.name);
}

/** Fetch and parse in one call — the unit index.js's cache layer rebuilds. */
async function buildIndex() {
  const xml = await fetchXml();
  const records = parseIndex(xml);
  return { records, fetchedAt: Date.now() };
}

// ── Match ────────────────────────────────────────────────────────────────

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '') // strip diacritics
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Text-match a query against a built index's records. Every query token
 * must appear somewhere in a candidate's name or one of its aliases — not
 * fuzzy, not phonetic, and the tool built on this says so plainly. A hit
 * means the text matched, nothing more; every result carries what it
 * matched on so an officer can judge it themselves.
 */
function search(records, query) {
  const qTokens = normalize(query).split(' ').filter(Boolean);
  if (!qTokens.length) return { found: false, matches: [], total: 0 };
  const hits = [];
  for (const r of records) {
    const nameNorm = normalize(r.name);
    if (qTokens.every((t) => nameNorm.includes(t))) {
      hits.push({ ...r, matchedOn: 'name' });
      continue;
    }
    const aliasHit = r.aliases.find((a) => {
      const an = normalize(a);
      return qTokens.every((t) => an.includes(t));
    });
    if (aliasHit) {
      hits.push({ ...r, matchedOn: `alias: ${aliasHit}` });
      continue;
    }
    const combined = normalize([r.name, ...r.aliases].join(' '));
    if (qTokens.every((t) => combined.includes(t))) {
      hits.push({ ...r, matchedOn: 'name and aliases combined' });
    }
  }
  return { found: hits.length > 0, matches: hits.slice(0, MAX_MATCHES), total: hits.length };
}

module.exports = {
  SOURCE_URL,
  CACHE_KEY,
  STALE_MS,
  MAX_MATCHES,
  fetchXml,
  parseIndex,
  buildIndex,
  normalize,
  search,
};
