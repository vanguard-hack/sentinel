'use strict';

// Unified source citation & attribution.
//
// Five lanes can answer a question — the QuickML knowledge base, the station's
// own digitised records, the Data Store (text2zcql), an attached image, and
// the web — and each describes its provenance differently. This module is the
// one place those descriptions become a single shape, so the API contract and
// the chat UI never have to know which lane ran.
//
// Two things make a citation worth having, and both are deliberate here:
//
//   • It must be checkable. A citation the officer cannot open is a claim, not
//     a source, so every entry carries whatever the UI needs to show the thing
//     itself — a record id, the retrieved passage, the matched rows.
//   • It must not leak. Source metadata is data: a document title can name a
//     victim, a filter clause can name the value it filtered on. Citations
//     therefore pass through the same clearance filter as the answer, and the
//     lane that has no clearance is not retrieved from at all.

const redaction = require('./redaction');

const TYPES = {
  RAG_DOCUMENT: 'rag_document',
  DATABASE_RECORD: 'database_record',
  EXTERNAL_WEB: 'external_web',
  VISION_EXTRACTION: 'vision_extraction',
};

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
};

const extOf = (name) => String(name || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] || '';
const mimeFor = (name) => MIME_BY_EXT[extOf(name)] || null;
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

// Pick the first present key from a bag of aliases. The QuickML retrieval
// payload is not a documented contract and its field names have moved, so
// every read of it goes through here rather than assuming one spelling.
const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};

// ── Lane 1: the knowledge base (unstructured documents) ─────────────────────

// Where in the document a chunk came from. A page is the most useful pointer;
// a section or a chunk index is better than nothing, and nothing is honest
// when the retriever gave us nothing.
function locationOf(node, meta) {
  const page = pick(node, ['page_label', 'page_number', 'page']) ?? pick(meta, ['page_label', 'page_number', 'page']);
  const section = pick(node, ['section', 'heading']) ?? pick(meta, ['section', 'heading']);
  const chunk = pick(node, ['chunk_index', 'node_index', 'chunk_id']) ?? pick(meta, ['chunk_index', 'node_index']);
  const parts = [];
  if (page !== null && page !== undefined) parts.push(`Page ${str(page, 12)}`);
  if (section) parts.push(`Section ${str(section, 60)}`);
  if (!parts.length && chunk !== null && chunk !== undefined) parts.push(`Chunk ${str(chunk, 12)}`);
  return parts.join(', ') || null;
}

// QuickML retrieved_nodes → rag_document sources.
//
// Several chunks routinely come back from the SAME document. They are folded
// into one citation carrying every passage, rather than five near-identical
// chips: the officer wants the document once, and then all of what was read
// from it.
function fromRagNodes(nodes) {
  const byDoc = new Map();
  for (const node of Array.isArray(nodes) ? nodes.slice(0, 24) : []) {
    if (!node || typeof node !== 'object') continue;
    const meta = (node.metadata && typeof node.metadata === 'object') ? node.metadata : {};
    const name = str(
      pick(node, ['document_title', 'document_name', 'file_name', 'filename', 'title', 'source']) ||
      pick(meta, ['document_title', 'document_name', 'file_name', 'filename', 'title', 'source']),
      160
    );
    if (!name) continue;
    const docId = str(pick(node, ['document_id', 'doc_id']) || pick(meta, ['document_id', 'doc_id']), 80);
    const key = docId || name.toLowerCase();
    const passage = {
      location: locationOf(node, meta),
      excerpt: str(pick(node, ['text', 'content', 'chunk', 'node_text', 'excerpt']) || pick(meta, ['text', 'content']), 1200),
      score: Number(pick(node, ['score', 'similarity', 'relevance'])) || null,
    };
    const existing = byDoc.get(key);
    if (existing) {
      if ((passage.location || passage.excerpt) && existing.passages.length < 6) existing.passages.push(passage);
      continue;
    }
    byDoc.set(key, {
      source_type: TYPES.RAG_DOCUMENT,
      display_name: name,
      location: passage.location,
      uri: str(pick(node, ['url', 'uri', 'file_url']) || pick(meta, ['url', 'uri', 'file_url']), 400) ||
        (docId ? `catalyst://knowledgebase/${docId}` : null),
      mime_type: mimeFor(name),
      collection: 'Knowledge base',
      passages: passage.location || passage.excerpt ? [passage] : [],
    });
  }
  return [...byDoc.values()];
}

// The knowledge base answered, but the retrieval payload named no documents.
// Still worth a citation — "which knowledge base" is provenance even when
// "which page" is unavailable — and it keeps the answer from looking like the
// model's own opinion.
const knowledgeBaseFallback = () => [{
  source_type: TYPES.RAG_DOCUMENT,
  display_name: 'Knowledge base',
  scope: 'Catalyst QuickML RAG',
  unresolved: true,
}];

// ── Lane 2: the station's digitised records ─────────────────────────────────

// One citation label for a digitised record.
//
// The record's title is usually derived FROM its filename, so naming both
// produced "Patel Public School Road.m4a (Patel Public School Road.m4a)". The
// filename is only worth adding when it says something the title does not —
// which it does once an officer has renamed the record.
function digitisedLabel(h) {
  const title = String((h && h.title) || '').trim();
  const file = String((h && h.filename) || '').trim();
  const stem = file.replace(/\.[^.]+$/, '');
  // Compare the label actually shown, not the title — an untitled record falls
  // back to its filename, and comparing the empty title would have let the
  // same name through twice all over again.
  const label = title || file;
  const redundant = !file || label === file || label === stem;
  return `${label}${redundant ? '' : ` (${file})`}`;
}

// How a record was captured decides what a citation may claim about it: a
// transcript is not a scan, and an officer told otherwise is being misled
// about how far to trust the words.
const KIND_NOTE = {
  scan: 'Scanned paper, read by OCR',
  image: 'Scanned paper, read by OCR',
  pdf: 'Scanned PDF, read by OCR',
  sheet: 'Spreadsheet, read directly',
  word: 'Document, read directly',
  slides: 'Presentation, read directly',
  text: 'Text file, read directly',
  audio: 'Transcript of an audio recording',
  video: 'Transcript of a video recording',
};

// searchDigitised hits → rag_document sources. `record_id` is what makes the
// chip openable: the UI fetches the record and shows the actual scan, page
// images or recording behind the sentence.
function fromDigitised(hits) {
  return (Array.isArray(hits) ? hits : []).map((h) => ({
    source_type: TYPES.RAG_DOCUMENT,
    display_name: digitisedLabel(h),
    location: KIND_NOTE[h.sourceKind] || 'Digitised record',
    uri: h.id ? `catalyst://records/${h.id}` : null,
    mime_type: mimeFor(h.filename),
    collection: 'Digitised records',
    record_id: str(h.id, 64) || null,
    doc_type: str(h.docType, 60) || null,
    source_kind: str(h.sourceKind, 24) || 'scan',
    passages: h.excerpt ? [{ location: null, excerpt: str(h.excerpt, 1200), score: h.score || null }] : [],
  }));
}

// ── Lane 3: the Data Store (text2zcql) ──────────────────────────────────────

// The evaluated WHERE clause, which is what "why these rows" actually means.
// Read off the executed query rather than the model's plan: the plan is a
// proposal, the executed string is what the database was asked.
function filterSummary(query) {
  const m = /\bwhere\b([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/i.exec(String(query || ''));
  return m ? str(m[1].replace(/\s+/g, ' ').trim(), 240) : null;
}

// Primary keys of the rows that came back. The FIR schema names them
// <Table>ID, so the first such column is the record's identity; without one
// (an aggregate, a rollup) there are no record ids to cite and saying so is
// better than inventing them.
function matchedRecordIds(rows) {
  const first = (Array.isArray(rows) ? rows : []).find((r) => r && typeof r === 'object');
  if (!first) return [];
  const idKey = Object.keys(first).find((k) => /(^|\.)\w*ID$/i.test(k) && !/^\w*(?:Type|Status)ID$/i.test(k));
  if (!idKey) return [];
  return [...new Set(rows.map((r) => r && r[idKey]).filter((v) => v !== undefined && v !== null && v !== ''))]
    .slice(0, 50)
    .map((v) => str(v, 40));
}

// One citation per table the query read. `records` carries a sample of the
// rows so the drawer can show the record itself — they are the already
// clearance-filtered rows, never the raw ones.
function fromZcql({ query, tables, rows }) {
  const list = (Array.isArray(tables) && tables.length ? tables : ['Data Store']).slice(0, 6);
  const filter = filterSummary(query);
  const ids = matchedRecordIds(rows);
  return list.map((table, i) => ({
    source_type: TYPES.DATABASE_RECORD,
    display_name: str(table, 80),
    identifier: ids.length ? `${ids.length} record${ids.length === 1 ? '' : 's'}` : null,
    scope: 'Catalyst DataStore (ZCQL Read-Only)',
    execution_type: 'Catalyst_DataStore_ZCQL_ReadOnly',
    filter_applied: filter,
    matched_record_ids: ids,
    // The rows are attached to the FIRST table only: a single-table query is
    // the only shape ZCQL supports here, and duplicating a 25-row sample per
    // table would just inflate the payload.
    records: i === 0 ? (Array.isArray(rows) ? rows.slice(0, 25) : []) : [],
    query: i === 0 ? str(query, 600) : null,
  }));
}

// ── Lane 4: vision (Zia OCR / the fast pre-parser) ──────────────────────────

function fromVision(digests) {
  return (Array.isArray(digests) ? digests : []).map((d) => {
    const fields = (d && d.fields && typeof d.fields === 'object') ? d.fields : {};
    const entries = Object.entries(fields).slice(0, 12);
    return {
      source_type: TYPES.VISION_EXTRACTION,
      display_name: d && d.model ? str(d.model, 60) : 'Zia Vision OCR',
      identifier: str(d && d.filename, 160) || 'Attached image',
      location: d && d.doc_type ? `Read as: ${str(d.doc_type, 60)}` : null,
      // The headline extraction, in the ticket's "License Plate: KA01AB1234"
      // form. The full set is carried alongside for the viewer.
      extracted_field: entries.length ? `${entries[0][0].replace(/_/g, ' ')}: ${str(entries[0][1], 80)}` : null,
      fields: entries.map(([k, v]) => ({ key: k.replace(/_/g, ' '), value: str(v, 120) })),
      objects: Array.isArray(d && d.objects) ? d.objects.slice(0, 8).map((o) => str(o, 40)) : [],
      graphic: d && d.graphic ? str(d.graphic, 40) : null,
      passages: d && d.text ? [{ location: null, excerpt: str(d.text, 1200), score: null }] : [],
      unreadable: !!(d && d.ok === false),
    };
  });
}

// ── Lane 5: the web (agentic tool observations) ─────────────────────────────

// An external link in a police answer is an instruction to go and read
// something. Anything not on this list is dropped rather than shown: a model
// that hallucinates a plausible URL, or a retrieved page that carries one,
// must not be able to put an arbitrary destination in front of an officer.
const DEFAULT_ALLOWLIST = [
  'mha.gov.in', 'india.gov.in', 'indiacode.nic.in', 'ncrb.gov.in', 'bprd.nic.in',
  'doj.gov.in', 'ecourts.gov.in', 'sci.gov.in', 'egazette.gov.in', 'prsindia.org',
  'karnataka.gov.in', 'ksp.karnataka.gov.in', 'morth.nic.in', 'parivahan.gov.in',
  'cybercrime.gov.in', 'nhrc.nic.in', 'lawmin.gov.in',
];

const allowlist = () =>
  (process.env.SOURCE_URL_ALLOWLIST
    ? process.env.SOURCE_URL_ALLOWLIST.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ALLOWLIST);

// Exact host or a subdomain of an allowed host — never a substring match,
// which would wave through "mha.gov.in.evil.example".
function isAllowedUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return allowlist().some((d) => host === d || host.endsWith(`.${d}`));
}

function fromWeb(observations) {
  const out = [];
  for (const o of Array.isArray(observations) ? observations.slice(0, 10) : []) {
    const url = str(o && (o.url || o.link), 400);
    if (!isAllowedUrl(url)) continue;
    const host = new URL(url).hostname.toLowerCase();
    out.push({
      source_type: TYPES.EXTERNAL_WEB,
      display_name: str(o.page_title || o.title, 160) || host,
      uri: url,
      domain: host,
      passages: o && o.snippet ? [{ location: null, excerpt: str(o.snippet, 600), score: null }] : [],
    });
  }
  return out;
}

// ── Clearance ───────────────────────────────────────────────────────────────

// Fields whose NAME alone discloses something — a filter clause reading
// "VictimName = 'Sunita R'" leaks the name it filtered on even though no row
// is shown. Clauses touching a field above the caller's clearance are removed
// from the citation, and the citation says so rather than silently shrinking.
function guardFilter(filter, role) {
  if (!filter) return { filter: null, dropped: [] };
  const clearance = redaction.clearanceOf(role);
  const dropped = [];
  const kept = filter
    .split(/\s+(?:and|AND)\s+/)
    .filter((clause) => {
      const field = Object.keys(redaction.FIELD_TIERS).find((f) => new RegExp(`\\b${f}\\b`, 'i').test(clause));
      if (field && clearance < redaction.FIELD_TIERS[field]) { dropped.push(field); return false; }
      return true;
    });
  return { filter: kept.join(' AND ') || null, dropped };
}

// The clearance filter, applied to citation METADATA.
//
// Tier 1 already kept unauthorised data out of the model's context. This is
// the same control applied to the provenance travelling beside the answer,
// because a citation is a disclosure too: the title of a restricted document,
// the value a query filtered on, a plate number read off a scan.
function clearanceFilter(list, role) {
  const clearance = redaction.clearanceOf(role);
  const removed = [];
  const out = [];
  for (const s of list || []) {
    const src = { ...s };
    if (src.source_type === TYPES.RAG_DOCUMENT && src.record_id && clearance < 2) {
      // A case record the caller may not open must not be named either — the
      // title alone can identify a complainant. Drop the citation whole.
      removed.push('digitised_record');
      continue;
    }
    if (src.source_type === TYPES.DATABASE_RECORD) {
      const g = guardFilter(src.filter_applied, role);
      src.filter_applied = g.filter;
      if (g.dropped.length) { src.filter_redacted = true; removed.push(...g.dropped); }
      if (src.records && src.records.length) {
        const f = redaction.filterRows(src.records, role);
        src.records = f.rows;
        removed.push(...f.redactions.map((r) => r.field));
      }
      // The executed query text is a developer aid, not evidence, and it
      // restates the filter it was just redacted out of.
      if (g.dropped.length) src.query = null;
    }
    if (src.passages && src.passages.length) {
      src.passages = src.passages.map((p) => {
        const f = redaction.filterText(p.excerpt, role);
        if (f.redactions.length) removed.push(...f.redactions.map((r) => r.field));
        return { ...p, excerpt: f.text };
      });
    }
    if (src.extracted_field) {
      const f = redaction.filterText(src.extracted_field, role);
      src.extracted_field = f.text;
      if (f.redactions.length) removed.push(...f.redactions.map((r) => r.field));
    }
    if (src.fields && src.fields.length) {
      src.fields = src.fields.map((kv) => {
        const f = redaction.filterText(kv.value, role);
        if (f.redactions.length) removed.push(...f.redactions.map((r) => r.field));
        return { ...kv, value: f.text };
      });
    }
    out.push(src);
  }
  return { sources: out, removed: [...new Set(removed)] };
}

// ── Merge, dedupe, number ───────────────────────────────────────────────────

// Two lanes running in parallel (the BOTH fan-out) routinely cite the same
// thing. Identity is the type plus what the citation actually points AT — the
// record, the document, the table, the URL — never the display name alone,
// which two different tables can share.
const identityOf = (s) =>
  [
    s.source_type,
    s.record_id || s.uri || String(s.display_name || '').toLowerCase(),
    s.source_type === TYPES.DATABASE_RECORD ? String(s.filter_applied || '') : '',
    s.source_type === TYPES.VISION_EXTRACTION ? String(s.identifier || '') : '',
  ].join('::');

// Merge preserves the FIRST occurrence's fields and folds in anything the
// duplicate knew that it did not — a second retrieval pass often returns the
// same document with a different passage, and losing that passage would lose
// the only pointer to where the answer came from.
function merge(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const s of list || []) {
      if (!s || !s.source_type || !s.display_name) continue;
      const id = identityOf(s);
      const existing = byId.get(id);
      if (!existing) { byId.set(id, { ...s, passages: [...(s.passages || [])] }); continue; }
      for (const p of s.passages || []) {
        const dup = existing.passages.some((q) => q.excerpt === p.excerpt && q.location === p.location);
        if (!dup && existing.passages.length < 6) existing.passages.push(p);
      }
      for (const [k, v] of Object.entries(s)) {
        if (k === 'passages') continue;
        if ((existing[k] === null || existing[k] === undefined || existing[k] === '') && v) existing[k] = v;
      }
    }
  }
  return [...byId.values()].map((s, i) => {
    const out = { source_id: `src_${String(i + 1).padStart(2, '0')}`, ...s };
    // Drop the keys that came out empty rather than shipping a payload of
    // nulls to the browser.
    for (const [k, v] of Object.entries(out)) {
      if (v === null || v === undefined || (Array.isArray(v) && !v.length)) delete out[k];
    }
    return out;
  });
}

// ── Audit ───────────────────────────────────────────────────────────────────

// A one-line rendering for the audit event's detail column, which is capped.
// The complete array is stored beside it; this is what a reviewer skims.
const auditLine = (list) =>
  (list || [])
    .map((s) => `${s.source_id}:${s.source_type}:${String(s.display_name || '').slice(0, 48)}`)
    .join(' | ')
    .slice(0, 400);

// The full array, trimmed of the bulky fields that exist for the UI. The audit
// record must say what was cited, not carry a copy of every passage.
const forAudit = (list) =>
  (list || []).slice(0, 30).map((s) => ({
    source_id: s.source_id,
    source_type: s.source_type,
    display_name: s.display_name,
    location: s.location,
    uri: s.uri,
    identifier: s.identifier,
    scope: s.scope,
    filter_applied: s.filter_applied,
    matched_record_ids: s.matched_record_ids ? s.matched_record_ids.slice(0, 25) : undefined,
    domain: s.domain,
    extracted_field: s.extracted_field,
    record_id: s.record_id,
  }));

module.exports = {
  TYPES,
  DEFAULT_ALLOWLIST,
  isAllowedUrl,
  digitisedLabel,
  fromRagNodes,
  knowledgeBaseFallback,
  fromDigitised,
  fromZcql,
  fromVision,
  fromWeb,
  filterSummary,
  matchedRecordIds,
  clearanceFilter,
  merge,
  auditLine,
  forAudit,
};
