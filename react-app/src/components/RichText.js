import React from 'react';

// Minimal markdown renderer for assistant prose: headings, blockquotes,
// ***bold italic***, **bold**, *italic*, _italic_, ~~strikethrough~~, `code`.
// Built as React elements (never dangerouslySetInnerHTML) so model output
// can't inject markup. Anything unrecognised renders as plain text.

const INLINE_RE =
  /(\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|\*[^*\n]+\*|__[^_\n]+__|_[^_\n]+_|~~[^~\n]+~~|`[^`\n]+`)/g;

function renderInline(text) {
  return text.split(INLINE_RE).map((part, i) => {
    if (/^\*\*\*[^*\n]+\*\*\*$/.test(part))
      return <strong key={i}><em>{part.slice(3, -3)}</em></strong>;
    if (/^\*\*[^*\n]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^\*[^*\n]+\*$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    if (/^__[^_\n]+__$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^_[^_\n]+_$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    if (/^~~[^~\n]+~~$/.test(part)) return <del key={i}>{part.slice(2, -2)}</del>;
    if (/^`[^`\n]+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}

export default function RichText({ text }) {
  const lines = String(text || '').split('\n');
  return (
    <>
      {lines.map((ln, i) => {
        const h = ln.match(/^(#{1,4})\s+(.*)/);
        if (h) {
          return (
            <div key={i} className={`as-md-h as-md-h${h[1].length}`}>
              {renderInline(h[2])}
            </div>
          );
        }
        const q = ln.match(/^>\s?(.*)/);
        if (q) {
          return (
            <div key={i} className="as-md-quote">
              {renderInline(q[1])}
            </div>
          );
        }
        if (!ln.trim()) return <div key={i} className="as-md-gap" />;
        return <div key={i}>{renderInline(ln)}</div>;
      })}
    </>
  );
}
