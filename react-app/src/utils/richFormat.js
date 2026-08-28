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

// Inline markdown → React nodes. Used for prose, table cells and card bodies
// alike so bold/links/code look the same everywhere.
export function renderInline(text, keyPrefix = 'i') {
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
    return <React.Fragment key={key}>{part}</React.Fragment>;
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

// Block-level parse for assistant prose: headings, quotes, bullet and numbered
// lists, and paragraphs — so spacing is structural rather than a pile of divs.
export function parseBlocks(text) {
  const lines = normaliseText(text).split('\n');
  const blocks = [];
  let para = [];
  let list = null; // { ordered, items: [] }

  const flushPara = () => {
    if (para.length) { blocks.push({ type: 'p', lines: para }); para = []; }
  };
  const flushList = () => {
    if (list && list.items.length) blocks.push({ type: 'list', ...list });
    list = null;
  };

  lines.forEach((raw) => {
    const ln = raw.replace(/\s+$/, '');
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
    const ordered = ln.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const bullet = ln.match(/^\s*[-*•]\s+(.*)$/);
    if (ordered || bullet) {
      flushPara();
      const isOrdered = !!ordered;
      if (!list || list.ordered !== isOrdered) { flushList(); list = { ordered: isOrdered, items: [] }; }
      list.items.push(ordered ? ordered[2] : bullet[1]);
      return;
    }
    flushList();
    para.push(ln);
  });
  flushPara();
  flushList();
  return blocks;
}
