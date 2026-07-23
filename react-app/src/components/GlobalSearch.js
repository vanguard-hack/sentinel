import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Search, CornerDownLeft, ArrowUp, ArrowDown } from 'lucide-react';
import { useAccess } from '../context/AccessContext';
import { canAccess } from '../utils/access';
import { searchTargets } from '../utils/searchIndex';

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);

// Command-palette style global navigator. A slim trigger lives in the top bar;
// ⌘K / Ctrl-K (or clicking it) opens a modal that fuzzy-searches every module,
// chart and sub-section and deep-links straight to it.
export default function GlobalSearch() {
  const navigate = useNavigate();
  const { role, ready } = useAccess();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const allowed = useCallback(
    (feature) => (!ready ? true : canAccess(role, feature)),
    [role, ready]
  );
  const results = useMemo(() => searchTargets(query, allowed), [query, allowed]);

  // Keep the highlighted row in range as results change.
  useEffect(() => { setActive(0); }, [query]);

  // Global shortcut: ⌘K / Ctrl-K opens; "/" opens when nothing is focused.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (
        e.key === '/' && !open &&
        !/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '') &&
        !document.activeElement?.isContentEditable
      ) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Focus the field and reset when the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      const t = setTimeout(() => inputRef.current?.focus(), 20);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const go = useCallback((entry) => {
    if (!entry) return;
    setOpen(false);
    const params = new URLSearchParams();
    if (entry.query) params.set('tab', entry.query);
    const search = params.toString() ? `?${params.toString()}` : '';
    const hash = entry.hash ? `#${entry.hash}` : '';
    navigate(`${entry.to}${search}${hash}`);
  }, [navigate]);

  const onListKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  // Scroll the active row into view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Group results for display while keeping a flat index for keyboard nav.
  const grouped = useMemo(() => {
    const map = new Map();
    results.forEach((e, idx) => {
      if (!map.has(e.group)) map.set(e.group, []);
      map.get(e.group).push({ ...e, idx });
    });
    return [...map.entries()];
  }, [results]);

  return (
    <>
      <button className="gs-trigger" onClick={() => setOpen(true)} aria-label="Search the app">
        <Search size={16} className="gs-trigger-icon" />
        <span className="gs-trigger-text">Search anything</span>
        <span className="gs-kbd">
          <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd><kbd>K</kbd>
        </span>
      </button>

      {open && createPortal(
        <div className="gs-overlay" onMouseDown={() => setOpen(false)}>
          <div className="gs-panel" role="dialog" aria-label="Search" onMouseDown={(e) => e.stopPropagation()}>
            <div className="gs-field">
              <Search size={18} className="gs-field-icon" />
              <input
                ref={inputRef}
                className="gs-input"
                placeholder="Search pages, charts, tabs…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onListKey}
                aria-label="Search query"
              />
              <kbd className="gs-esc">Esc</kbd>
            </div>

            <div className="gs-results" ref={listRef}>
              {results.length === 0 && (
                <div className="gs-empty">No matches for “{query}”</div>
              )}
              {grouped.map(([group, items]) => (
                <div className="gs-group" key={group}>
                  <div className="gs-group-label">{group}</div>
                  {items.map((e) => (
                    <button
                      key={e.id}
                      data-idx={e.idx}
                      className={`gs-row ${e.idx === active ? 'active' : ''}`}
                      onMouseEnter={() => setActive(e.idx)}
                      onClick={() => go(e)}
                    >
                      <span className="gs-row-icon"><e.Icon size={16} /></span>
                      <span className="gs-row-text">
                        <span className="gs-row-title">{e.title}</span>
                        {e.sub && <span className="gs-row-sub">{e.sub}</span>}
                      </span>
                      {e.idx === active && <CornerDownLeft size={14} className="gs-row-enter" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>

            <div className="gs-foot">
              <span><kbd><ArrowUp size={11} /></kbd><kbd><ArrowDown size={11} /></kbd> navigate</span>
              <span><kbd><CornerDownLeft size={11} /></kbd> open</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
