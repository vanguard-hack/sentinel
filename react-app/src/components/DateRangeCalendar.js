import React, { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

// Month-grid date-range picker (no deps). Dates in/out as 'YYYY-MM-DD'.
// First click sets the start, second the end; clicking before the start
// restarts the selection. Parent owns from/to and renders Apply/Clear.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const isoOf = (y, m, d) =>
  new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

export default function DateRangeCalendar({ from, to, onSelect }) {
  const seed = from ? new Date(from + 'T00:00:00Z') : new Date();
  const [view, setView] = useState({
    y: seed.getUTCFullYear(),
    m: seed.getUTCMonth(),
  });
  // Drill-up navigation: click the title to zoom days → months → years, then
  // picking zooms back down — no arrow-mashing to reach another year.
  const [mode, setMode] = useState('days'); // 'days' | 'months' | 'years'
  const [yearBase, setYearBase] = useState(Math.floor(seed.getUTCFullYear() / 12) * 12);

  const shift = (delta) => {
    if (mode === 'years') {
      setYearBase((b) => b + delta * 12);
    } else if (mode === 'months') {
      setView(({ y, m }) => ({ y: y + delta, m }));
    } else {
      setView(({ y, m }) => {
        const d = new Date(Date.UTC(y, m + delta, 1));
        return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
      });
    }
  };
  const zoomOut = () => {
    if (mode === 'days') setMode('months');
    else if (mode === 'months') {
      setYearBase(Math.floor(view.y / 12) * 12);
      setMode('years');
    }
  };

  // 6 weeks starting on the Sunday on/before the 1st (Sun-first, as in the design).
  const lead = new Date(Date.UTC(view.y, view.m, 1)).getUTCDay();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(view.y, view.m, 1 - lead + i));
    cells.push({
      iso: d.toISOString().slice(0, 10),
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() === view.m,
    });
  }

  const pick = (iso) => {
    if (!from || (from && to) || iso < from) onSelect(iso, '');
    else onSelect(from, iso);
  };

  const today = isoOf(
    new Date().getFullYear(), new Date().getMonth(), new Date().getDate()
  );

  const title =
    mode === 'years' ? `${yearBase} – ${yearBase + 11}`
      : mode === 'months' ? String(view.y)
      : `${MONTHS[view.m]} ${view.y}`;

  return (
    <div className="drc">
      <div className="drc-head">
        <button
          type="button"
          className="drc-title drc-title-btn"
          onClick={zoomOut}
          title={mode === 'days' ? 'Pick a month' : mode === 'months' ? 'Pick a year' : undefined}
        >
          {title}
        </button>
        <span className="drc-nav">
          <button type="button" onClick={() => shift(-1)} aria-label="Previous">
            <ChevronLeft size={16} />
          </button>
          <button type="button" onClick={() => shift(1)} aria-label="Next">
            <ChevronRight size={16} />
          </button>
        </span>
      </div>

      {mode === 'years' && (
        <div className="drc-mgrid">
          {Array.from({ length: 12 }, (_, i) => yearBase + i).map((yr) => (
            <button
              key={yr}
              type="button"
              className={`drc-mcell ${yr === view.y ? 'active' : ''}`}
              onClick={() => { setView((v) => ({ ...v, y: yr })); setMode('months'); }}
            >
              {yr}
            </button>
          ))}
        </div>
      )}

      {mode === 'months' && (
        <div className="drc-mgrid">
          {MONTHS.map((mn, i) => (
            <button
              key={mn}
              type="button"
              className={`drc-mcell ${i === view.m ? 'active' : ''}`}
              onClick={() => { setView((v) => ({ ...v, m: i })); setMode('days'); }}
            >
              {mn.slice(0, 3)}
            </button>
          ))}
        </div>
      )}

      {mode === 'days' && (
      <div className="drc-grid">
        {DOW.map((d, i) => (
          <span key={i} className="drc-dow">{d}</span>
        ))}
        {cells.map((c) => {
          const isStart = c.iso === from;
          const isEnd = c.iso === (to || from);
          const inRange = from && to && c.iso > from && c.iso < to;
          const cls = [
            'drc-day',
            c.inMonth ? '' : 'out',
            inRange ? 'range' : '',
            isStart ? 'start' : '',
            isEnd ? 'end' : '',
            from && to && (isStart || isEnd) && from !== to ? 'has-range' : '',
            c.iso === today ? 'today' : '',
          ].filter(Boolean).join(' ');
          return (
            <button key={c.iso} type="button" className={cls} onClick={() => pick(c.iso)}>
              <span>{c.day}</span>
            </button>
          );
        })}
      </div>
      )}
    </div>
  );
}
