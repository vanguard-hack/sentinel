import React, { useEffect, useRef } from 'react';

// Command autocomplete for the assistant composer. Opens on a leading '/',
// filters as the officer types, and is driven entirely from the keyboard —
// arrows to move, Enter or Tab to accept, Escape to dismiss — since the point
// of the feature is not having to reach for the mouse.
export default function SlashMenu({ commands, active, onPick, onHover }) {
  const listRef = useRef(null);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelector('.sc-item.active');
    // Guarded: not every environment implements scrollIntoView, and failing to
    // scroll must never take the menu down with it.
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!commands.length) return null;

  let lastCategory = null;
  return (
    <div className="sc-menu" role="listbox" aria-label="Commands" ref={listRef}>
      {commands.map((c, i) => {
        const header = c.category !== lastCategory ? c.category : null;
        lastCategory = c.category;
        return (
          <React.Fragment key={c.name}>
            {header && <div className="sc-group">{header}</div>}
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              className={`sc-item${i === active ? ' active' : ''}`}
              onMouseEnter={() => onHover(i)}
              // mousedown, not click: the composer must not lose focus first
              onMouseDown={(e) => { e.preventDefault(); onPick(c); }}
            >
              <span className="sc-name">/{c.name}</span>
              <span className="sc-desc">{c.desc}</span>
              {c.arg && <span className="sc-arg">{c.arg}</span>}
            </button>
          </React.Fragment>
        );
      })}
      <div className="sc-foot">
        <kbd>↑</kbd><kbd>↓</kbd> to navigate · <kbd>↵</kbd> to select · <kbd>esc</kbd> to dismiss
      </div>
    </div>
  );
}
