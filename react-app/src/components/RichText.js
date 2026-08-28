import React from 'react';
import { parseBlocks, renderInline } from '../utils/richFormat';

// Assistant prose. The parsing lives in utils/richFormat so table cells, card
// bodies and prose all format identically — see the note there on why model
// output has to be normalised before display.
export default function RichText({ text }) {
  const blocks = parseBlocks(text);
  if (!blocks.length) return null;
  return (
    <div className="rf-prose">
      {blocks.map((b, i) => {
        if (b.type === 'h') {
          return <div key={i} className={`as-md-h as-md-h${b.level}`}>{renderInline(b.text, `h${i}`)}</div>;
        }
        if (b.type === 'quote') {
          return <div key={i} className="as-md-quote">{renderInline(b.text, `q${i}`)}</div>;
        }
        if (b.type === 'hr') return <hr key={i} className="rf-hr" />;
        if (b.type === 'list') {
          const List = b.ordered ? 'ol' : 'ul';
          return (
            <List key={i} className="rf-list">
              {b.items.map((it, j) => <li key={j}>{renderInline(it, `l${i}-${j}`)}</li>)}
            </List>
          );
        }
        return (
          <p key={i} className="rf-p">
            {b.lines.map((ln, j) => (
              <React.Fragment key={j}>
                {j > 0 && <br />}
                {renderInline(ln, `p${i}-${j}`)}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
