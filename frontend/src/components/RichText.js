import React from 'react';
import { parseBlocks, renderInline, renderCell } from '../utils/richFormat';

// A list item can carry its own nested list (see richFormat's stack-based
// parse) — rendered recursively so "- A: \n  - B" becomes a real <ul> inside
// <li>, not a second flat list at the same level as its parent.
function renderListItems(items, keyPrefix, opts) {
  return items.map((it, j) => {
    const key = `${keyPrefix}-${j}`;
    const Nested = it.children ? (it.children.ordered ? 'ol' : 'ul') : null;
    return (
      <li key={j}>
        {renderInline(it.text, key, opts)}
        {Nested && <Nested className="rf-list">{renderListItems(it.children.items, key, opts)}</Nested>}
      </li>
    );
  });
}

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
              {renderListItems(b.items, `l${i}`, opts)}
            </List>
          );
        }
        // A markdown table that slipped past the backend's own conversion
        // into a real `table` agui component — defense in depth, not the
        // primary path. See richFormat.parseBlocks.
        if (b.type === 'table') {
          return (
            <div className="cf-table-wrap" key={i}>
              <table className="cf-table">
                <thead>
                  <tr>{b.columns.map((c, j) => <th key={j}>{renderInline(c, `th${i}-${j}`, opts)}</th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>{r.map((cell, k) => <td key={k}>{renderCell(cell)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
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
