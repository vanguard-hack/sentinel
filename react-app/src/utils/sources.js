// The citation model, client side.
//
// The assistant's backend returns a unified `sources` array — one shape for
// knowledge-base documents, digitised station records, Data Store tables,
// attached-image extractions and external pages. This module is the only place
// that shape is interpreted, so the chip, the viewer and the footnote marker
// can never disagree about what a citation says.
//
// It also absorbs history. Conversations saved before the unified contract
// carry `sources` as plain strings ("Data Store: CaseMaster"), and those
// conversations are still in officers' sidebars. A string becomes a citation
// with a name and nothing else: it is shown, and it is not clickable, which is
// the truth about it.

export const TYPES = {
  RAG_DOCUMENT: 'rag_document',
  DATABASE_RECORD: 'database_record',
  EXTERNAL_WEB: 'external_web',
  VISION_EXTRACTION: 'vision_extraction',
};

// What each type is called in the UI. The officer's words, not the schema's.
export const TYPE_LABEL = {
  [TYPES.RAG_DOCUMENT]: 'Document',
  [TYPES.DATABASE_RECORD]: 'Record',
  [TYPES.EXTERNAL_WEB]: 'Web',
  [TYPES.VISION_EXTRACTION]: 'Image',
  legacy: 'Source',
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// A legacy string citation, promoted just far enough to render. The type is
// guessed from the prefix the old code wrote, which is only a display hint —
// nothing interactive is offered, because there is nothing behind it.
function fromLegacyString(text, i) {
  const s = String(text).trim();
  const type =
    /^Data Store/i.test(s) ? TYPES.DATABASE_RECORD
      : /^Attached image/i.test(s) ? TYPES.VISION_EXTRACTION
        : TYPES.RAG_DOCUMENT;
  return {
    source_id: `src_${String(i + 1).padStart(2, '0')}`,
    source_type: type,
    display_name: s.replace(/^(?:Data Store|Digitised record|Attached image):\s*/i, '') || s,
    legacy: true,
  };
}

export function normaliseSources(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(Boolean)
    .map((s, i) => (isObj(s) ? s : fromLegacyString(s, i)))
    .filter((s) => s.display_name)
    .map((s, i) => ({
      // Numbering is positional and 1-based so it matches the [1] the model
      // wrote into the prose. A backend-assigned source_id is kept for the
      // audit trail, but the footnote number is what the officer sees.
      n: i + 1,
      ...s,
      source_id: s.source_id || `src_${String(i + 1).padStart(2, '0')}`,
      passages: Array.isArray(s.passages) ? s.passages : [],
    }));
}

// Is there anything to show if this chip is clicked? A citation with no
// record, no passage, no rows and no URL opens an empty panel, so it is
// rendered as a plain label instead of a button that lies about being one.
export function isOpenable(s) {
  if (!s || s.legacy) return false;
  if (s.source_type === TYPES.EXTERNAL_WEB) return !!s.uri;
  if (s.source_type === TYPES.DATABASE_RECORD) {
    return !!(s.filter_applied || (s.records && s.records.length) || (s.matched_record_ids || []).length);
  }
  if (s.source_type === TYPES.RAG_DOCUMENT) return !!(s.record_id || s.passages.length);
  if (s.source_type === TYPES.VISION_EXTRACTION) {
    return !!(s.passages.length || (s.fields && s.fields.length) || s.extracted_field);
  }
  return false;
}

// The second line on a chip — where the citation points, in as few words as
// carry meaning. Never a repeat of the display name.
export function subtitleOf(s) {
  if (!s) return '';
  if (s.source_type === TYPES.EXTERNAL_WEB) return s.domain || '';
  if (s.source_type === TYPES.DATABASE_RECORD) return s.identifier || s.scope || '';
  if (s.source_type === TYPES.VISION_EXTRACTION) return s.extracted_field || s.identifier || '';
  return s.location || s.collection || '';
}

// Records in the drawer are shown as a field list, so the columns need a
// stable order and readable names. ZCQL flattens joined columns to
// "Table.Column"; the officer wants the column.
export const fieldLabel = (key) =>
  String(key)
    .split('.')
    .pop()
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ');

export const columnsOf = (records) => {
  const seen = [];
  for (const r of records || []) {
    for (const k of Object.keys(r || {})) if (!seen.includes(k)) seen.push(k);
  }
  return seen;
};
