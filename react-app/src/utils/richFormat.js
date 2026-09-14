// One formatter for everything the assistant renders — prose, table cells,
// card bodies, chart labels.
//
// Model output is inconsistent: it mixes markdown (**bold**, `code`, lists)
// with stray HTML (<br>, <b>), sometimes inside a table cell where markdown was
// never appropriate. Rendering that raw put literal "**Legal Basis**" and
// "<br>" on screen. Everything therefore passes through here so the officer
// sees consistent typography wherever the text ends up.
//
// Output is React elements, never dangerouslySetInnerHTML: the model must
// never be able to inject markup.
import React from 'react';

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—', '&hellip;': '…',
};

// Fold the HTML the model sometimes emits into plain text + real newlines.
// Block-ish tags become line breaks; everything else is dropped rather than
// shown, since it was never meant to be read.
export function normaliseText(input) {
  let s = String(input == null ? '' : input);
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n');
  s = s.replace(/<\s*li\s*[^>]*>/gi, '\n• ');
  s = s.replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<\/?[a-z][^>]*>/gi, '');
  s = s.replace(/&[a-z#0-9]+;/gi, (m) => (ENTITIES[m.toLowerCase()] !== undefined ? ENTITIES[m.toLowerCase()] : m));
  s = s.replace(/ /g, ' ');
  // Collapse runs of blank lines so spacing stays even.
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const INLINE_RE =
  /(\[[^\]\n]+\]\((?:https?:\/\/|\/)[^)\s]+\)|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|(?<![\w*])\*[^*\n]+\*(?![\w*])|__[^_\n]+__|(?<![\w_])_[^_\n]+_(?![\w_])|~~[^~\n]+~~|`[^`\n]+`|https?:\/\/[^\s<>()]+)/g;

// Footnote markers written into the prose by the model — "[1]", "[2]".
//
// These are real references: the digitised-records lane instructs the model to
// cite the bracketed source number after any statement drawn from a record, so
// the marker and the citation chip below the message are the same source. A
// marker with no source behind it (a model writing "[3]" when three sources
// were not returned) stays plain text — a button that opens nothing is worse
// than no button.
const CITE_RE = /(\[\d{1,2}\])/g;

// Domain entities worth calling out inline: a crime/case number (this store's
// numbers run to 9+ digits — FIR/CaseMasterID, never a phone or a plain
// count), a statute + section citation, a rupee amount, and a risk or
// confidence percentage. Highlighted so the load-bearing detail in an answer
// catches an officer's eye without the model having to backtick anything.
const ENTITY_SRC =
  '\\b\\d{9,}\\b' +
  '|\\b(?:IPC|BNS|BNSS|BSA|CrPC|POCSO|NDPS|PMLA)\\s+\\d+[A-Za-z]?(?:\\(\\d+\\))?\\b' +
  '|₹\\s?[\\d,]+(?:\\.\\d+)?(?:\\s?(?:lakh|crore))?' +
  '|\\b\\d{1,3}(?:\\.\\d+)?%';
const ENTITY_RE = new RegExp(`(${ENTITY_SRC})`, 'g');
const ENTITY_TEST_RE = new RegExp(`^(?:${ENTITY_SRC})$`);

// Wrap entity matches inside a run of plain text. Returns an array of
// strings/elements, not a single node — callers splice it into whatever list
// they are already building (a citation-split fragment, or the whole part).
function highlightEntities(text, keyPrefix) {
  const parts = String(text).split(ENTITY_RE);
  if (parts.length === 1) return [text];
  return parts.filter((p) => p !== undefined && p !== '').map((part, i) => (
    ENTITY_TEST_RE.test(part)
      ? <span className="rf-entity" key={`${keyPrefix}-e${i}`}>{part}</span>
      : part
  ));
}

function withCitations(text, key, opts) {
  const parts = text.split(CITE_RE);
  if (parts.length === 1) return <React.Fragment key={key}>{highlightEntities(text, key)}</React.Fragment>;
  return (
    <React.Fragment key={key}>
      {parts.filter((p) => p !== '').map((part, i) => {
        const m = /^\[(\d{1,2})\]$/.exec(part);
        const n = m ? Number(m[1]) : 0;
        if (!n || n > opts.citationCount) return <React.Fragment key={i}>{highlightEntities(part, `${key}-${i}`)}</React.Fragment>;
        return (
          <button
            key={i}
            type="button"
            className="rf-cite"
            onClick={() => opts.onCitation(n)}
            title={`Open source ${n}`}
          >
            {n}
          </button>
        );
      })}
    </React.Fragment>
  );
}

// Inline markdown → React nodes. Used for prose, table cells and card bodies
// alike so bold/links/code look the same everywhere. `opts.onCitation` is
// optional: without it a footnote marker renders exactly as it always did.
export function renderInline(text, keyPrefix = 'i', opts = null) {
  const parts = String(text == null ? '' : text).split(INLINE_RE);
  return parts.filter((p) => p !== undefined && p !== '').map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    const link = part.match(/^\[([^\]\n]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)$/);
    if (link) {
      const external = /^https?:\/\//.test(link[2]);
      return (
        <a key={key} href={link[2]} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
          {link[1]}
        </a>
      );
    }
    if (/^https?:\/\/[^\s<>()]+$/.test(part)) {
      return <a key={key} href={part} target="_blank" rel="noopener noreferrer">{part}</a>;
    }
    if (/^\*\*\*[^*\n]+\*\*\*$/.test(part)) return <strong key={key}><em>{part.slice(3, -3)}</em></strong>;
    if (/^\*\*[^*\n]+\*\*$/.test(part)) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (/^__[^_\n]+__$/.test(part)) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (/^\*[^*\n]+\*$/.test(part)) return <em key={key}>{part.slice(1, -1)}</em>;
    if (/^_[^_\n]+_$/.test(part)) return <em key={key}>{part.slice(1, -1)}</em>;
    if (/^~~[^~\n]+~~$/.test(part)) return <del key={key}>{part.slice(2, -2)}</del>;
    if (/^`[^`\n]+`$/.test(part)) return <code key={key}>{part.slice(1, -1)}</code>;
    if (opts && opts.onCitation) return withCitations(part, key, opts);
    return <React.Fragment key={key}>{highlightEntities(part, key)}</React.Fragment>;
  });
}

// A table cell or card body: normalise, then render each line, so a cell that
// arrived as "a<br>b" reads as two lines rather than one run-on string.
export function renderCell(value) {
  if (value == null || value === '') return '—';
  const lines = normaliseText(value).split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return '—';
  if (lines.length === 1) return renderInline(lines[0]);
  return lines.map((ln, i) => {
    const bullet = ln.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    return (
      <span className="rf-cell-line" key={i}>
        {bullet ? <><span className="rf-cell-bullet">•</span>{renderInline(bullet[1], `c${i}`)}</> : renderInline(ln, `c${i}`)}
      </span>
    );
  });
}

// A markdown table row — the same test the backend's own stripMarkdownTables
// uses, so a table that slipped past that safety net is still recognised the
// same way here. A cell is a separator ("---", ":--:") when every cell in
// the row matches; that row is dropped rather than shown as data.
const isTableRow = (ln) => /^\s*\|.*\|\s*$/.test(ln);
const isSeparatorRow = (cells) => cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '');
const splitRow = (ln) => ln.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

// Block-level parse for assistant prose: headings, quotes, tables, nested
// bullet/numbered lists, and paragraphs — so spacing is structural rather
// than a pile of divs.
//
// This is defense in depth, not the primary control — the backend's own
// sanitizeForDisplay (functions/rag/index.js) is what should convert a
// model's stray markdown table into a real `table` agui component before it
// ever reaches here. This exists for whatever gets past that anyway: a
// knowledge-base excerpt quoted verbatim, a future call site that forgets.
export function parseBlocks(text) {
  const lines = normaliseText(text).split('\n');
  const blocks = [];
  let para = [];
  // Nested lists are tracked as a stack of open frames, one per indent level
  // seen so far; `topList` is the single top-level list object the whole
  // chain eventually becomes one block for. An item earns a nested list by
  // being the most recent item at the level a deeper indent attaches to.
  let topList = null; // { ordered, items: [{ text, children }] }
  let stack = []; // [{ indent, list }]
  let tableRun = []; // consecutive raw lines that look like `| a | b |`

  const flushPara = () => {
    if (para.length) { blocks.push({ type: 'p', lines: para }); para = []; }
  };
  const flushList = () => {
    if (topList && topList.items.length) blocks.push({ type: 'list', ...topList });
    topList = null;
    stack = [];
  };
  const flushTable = () => {
    if (tableRun.length < 2) { para.push(...tableRun); tableRun = []; return; }
    const rows = tableRun.map(splitRow);
    if (!isSeparatorRow(rows[1])) { para.push(...tableRun); tableRun = []; return; }
    const dataRows = rows.slice(2).filter((cells) => !isSeparatorRow(cells));
    blocks.push({ type: 'table', columns: rows[0], rows: dataRows });
    tableRun = [];
  };

  lines.forEach((raw) => {
    const ln = raw.replace(/\s+$/, '');

    if (isTableRow(ln)) { flushPara(); flushList(); tableRun.push(ln); return; }
    flushTable();

    if (!ln.trim()) { flushPara(); flushList(); return; }

    const heading = ln.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2] });
      return;
    }
    // A lone bolded line acts as a heading — the model uses it that way.
    const boldHeading = ln.match(/^\*\*([^*]+)\*\*:?\s*$/);
    if (boldHeading) {
      flushPara(); flushList();
      blocks.push({ type: 'h', level: 4, text: boldHeading[1] });
      return;
    }
    const quote = ln.match(/^>\s?(.*)$/);
    if (quote) {
      flushPara(); flushList();
      blocks.push({ type: 'quote', text: quote[1] });
      return;
    }
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(ln)) {
      flushPara(); flushList();
      blocks.push({ type: 'hr' });
      return;
    }
    const ordered = ln.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    const bullet = ln.match(/^(\s*)[-*•]\s+(.*)$/);
    if (ordered || bullet) {
      flushPara();
      const indent = (ordered || bullet)[1].length;
      const isOrdered = !!ordered;
      const itemText = ordered ? ordered[3] : bullet[2];
      const item = { text: itemText, children: null };
      if (!stack.length) {
        topList = { ordered: isOrdered, items: [item] };
        stack.push({ indent, list: topList });
      } else {
        while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
        const top = stack[stack.length - 1];
        if (indent > top.indent) {
          const parentItem = top.list.items[top.list.items.length - 1];
          const nested = { ordered: isOrdered, items: [item] };
          parentItem.children = nested;
          stack.push({ indent, list: nested });
        } else {
          top.list.items.push(item);
        }
      }
      return;
    }
    flushList();
    para.push(ln);
  });
  flushTable();
  flushPara();
  flushList();
  return blocks;
}
