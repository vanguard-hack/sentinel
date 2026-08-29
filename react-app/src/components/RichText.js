import React from 'react';
import { parseBlocks, renderInline } from '../utils/richFormat';

// Assistant prose. The parsing lives in utils/richFormat so table cells, card
// bodies and prose all format identically — see the note there on why model
// output has to be normalised before display.
// `onCitation` makes the model's "[1]" markers clickable, wired to the source
// of that number below the message. Omitted everywhere else, so prose that has
// no citations behind it renders unchanged.
export default function RichText({ text, onCitation, citationCount = 0 }) {
  const blocks = parseBlocks(text);
  if (!blocks.length) return null;
  const opts = onCitation && citationCount ? { onCitation, citationCount } : null;
  return (
    <div className="rf-prose">
      {blocks.map((b, i) => {
        if (b.type === 'h') {
          return <div key={i} className={`as-md-h as-md-h${b.level}`}>{renderInline(b.text, `h${i}`, opts)}</div>;
        }
        if (b.type === 'quote') {
          return <div key={i} className="as-md-quote">{renderInline(b.text, `q${i}`, opts)}</div>;
        }
        if (b.type === 'hr') return <hr key={i} className="rf-hr" />;
        if (b.type === 'list') {
          const List = b.ordered ? 'ol' : 'ul';
          return (
            <List key={i} className="rf-list">
              {b.items.map((it, j) => <li key={j}>{renderInline(it, `l${i}-${j}`, opts)}</li>)}
            </List>
          );
        }
        return (
          <p key={i} className="rf-p">
            {b.lines.map((ln, j) => (
              <React.Fragment key={j}>
                {j > 0 && <br />}
                {renderInline(ln, `p${i}-${j}`, opts)}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
