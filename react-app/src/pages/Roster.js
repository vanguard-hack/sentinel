import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CalendarClock, CalendarDays, Search, X, ChevronLeft, ChevronRight, RefreshCw, AlertTriangle,
} from 'lucide-react';
import { loadPersonnel } from '../utils/personnel';
import {
  SHIFT_TYPES, LEGEND, mondayOf, mondayOfIso, shiftWeek, weekDays, weekRoster,
} from '../utils/roster';
import TopBar from '../components/TopBar';
import RankInsignia from '../components/RankInsignia';
import DateRangeCalendar from '../components/DateRangeCalendar';

const PER_PAGE = 15;

const hueOf = (id) => (Number(id) * 137) % 360;
const initialsOf = (name) =>
  String(name)
    .split(' ')
    .filter((w) => w && !/^dr\.?$/i.test(w))
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

function ShiftChip({ shiftKey }) {
  const s = SHIFT_TYPES[shiftKey];
  return (
    <div className={`ro-chip ro-${shiftKey}`}>
      <span className="ro-chip-label">{s.label}</span>
      {s.time && <span className="ro-chip-time">{s.time}</span>}
    </div>
  );
}

export default function Roster() {
  const [params] = useSearchParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [week, setWeek] = useState(() => mondayOf());
  const [searchInput, setSearchInput] = useState(params.get('q') || '');
  const [search, setSearch] = useState((params.get('q') || '').toLowerCase());
  const [district, setDistrict] = useState('All');
  const [rank, setRank] = useState('All');
  const [page, setPage] = useState(1);
  const [calOpen, setCalOpen] = useState(false);
  const calRef = useRef(null);

  useEffect(() => {
    if (!calOpen) return undefined;
    const onDown = (e) => {
      if (calRef.current && !calRef.current.contains(e.target)) setCalOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setCalOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [calOpen]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await loadPersonnel());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim().toLowerCase()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  useEffect(() => { setPage(1); }, [search, district, rank]);

  const officers = useMemo(() => data?.officers || [], [data]);

  const filtered = useMemo(() => {
    // Suspended officers are off the rolls — no roster shown for them.
    let out = officers.filter((o) => o.status !== 'Suspended');
    if (district !== 'All') out = out.filter((o) => o.district === district);
    if (rank !== 'All') out = out.filter((o) => o.rankAbbr === rank);
    if (search) {
      out = out.filter((o) =>
        [o.name, o.kgid, o.unit, o.district, o.rank, o.rankAbbr]
          .some((v) => String(v).toLowerCase().includes(search))
      );
    }
    return [...out].sort(
      (a, b) => a.rankHierarchy - b.rankHierarchy || a.name.localeCompare(b.name)
    );
  }, [officers, district, rank, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  const days = weekDays(week);
  const todayIso = new Date().toISOString().slice(0, 10);
  const ddmmyyyy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

  return (
    <div className="cf-page">
      <TopBar title="Duty Roster" subtitle="Weekly shift schedule" />

      <div className="pp-body">
        {/* Toolbar */}
        <div className="pp-toolbar">
          <div className="ro-weeknav">
            <button
              className="ro-weeknav-btn"
              onClick={() => setWeek((w) => shiftWeek(w, -1))}
              aria-label="Previous week"
            >
              <ChevronLeft size={16} />
            </button>

            <div className="ro-weekfield-wrap" ref={calRef}>
              <button
                className="ro-weekfield"
                onClick={() => setCalOpen((o) => !o)}
                aria-haspopup="dialog"
                aria-expanded={calOpen}
                title="Pick a week"
              >
                <span>{ddmmyyyy(week)} - {ddmmyyyy(days[6].iso)}</span>
                <CalendarDays size={16} />
              </button>

              {calOpen && (
                <div className="rp-cal-pop ro-cal-pop" role="dialog" aria-label="Pick a week">
                  <DateRangeCalendar
                    from={week}
                    to={days[6].iso}
                    onSelect={(f) => { setWeek(mondayOfIso(f)); setCalOpen(false); }}
                  />
                </div>
              )}
            </div>

            <button
              className="ro-weeknav-btn"
              onClick={() => setWeek((w) => shiftWeek(w, 1))}
              aria-label="Next week"
            >
              <ChevronRight size={16} />
            </button>
            {week !== mondayOf() && (
              <button className="ro-weeknav-today" onClick={() => setWeek(mondayOf())}>
                This week
              </button>
            )}
          </div>

          <div className="pp-controls">
            <div className="cf-search pp-search">
              <Search size={14} className="cf-search-icon" />
              <input
                className="cf-search-input"
                placeholder="Search officer, station…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              {searchInput && (
                <button className="cf-search-clear" onClick={() => setSearchInput('')}>
                  <X size={13} />
                </button>
              )}
            </div>

            <select className="cf-select" value={district} onChange={(e) => setDistrict(e.target.value)} title="District">
              <option value="All">All districts</option>
              {(data?.districtOptions || []).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>

            <select className="cf-select" value={rank} onChange={(e) => setRank(e.target.value)} title="Rank">
              <option value="All">All ranks</option>
              {(data?.rankOptions || []).map((r) => <option key={r} value={r}>{r}</option>)}
            </select>

            <button className="cf-icon-btn" onClick={load} title="Refresh" disabled={loading}>
              <RefreshCw size={15} className={loading ? 'cf-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Legend */}
        <div className="ro-legend">
          {LEGEND.map((k) => (
            <span key={k} className="ro-legend-item">
              <span className={`ro-legend-dot ro-${k}`} />
              {SHIFT_TYPES[k].label}
              {SHIFT_TYPES[k].time && <span className="ro-legend-time">{SHIFT_TYPES[k].time}</span>}
            </span>
          ))}
        </div>

        {/* Grid */}
        <div className="cf-table-wrap">
          {error ? (
            <div className="cf-state cf-error">
              <AlertTriangle size={22} />
              <p>{error}</p>
              <button className="cf-retry" onClick={load}>Retry</button>
            </div>
          ) : loading ? (
            <div className="cf-state">
              <div className="cf-spinner" />
              <p>Loading duty roster…</p>
            </div>
          ) : !pageRows.length ? (
            <div className="cf-state">
              <CalendarClock size={22} />
              <p>No personnel match the current filters.</p>
            </div>
          ) : (
            <div className="cf-scroll">
              <table className="cf-table ro-table">
                <thead>
                  <tr>
                    <th className="ro-officer-col">Officer</th>
                    {days.map((d) => (
                      <th key={d.iso} className={d.iso === todayIso ? 'ro-today' : ''}>
                        <span className="ro-dow">{d.dow}</span>
                        <span className="ro-date">{d.day} {d.month}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((o) => {
                    const shifts = weekRoster(o, week);
                    return (
                      <tr key={o.id}>
                        <td className="ro-officer-col">
                          <div className="pp-officer">
                            <div
                              className="pp-avatar"
                              style={{ width: 32, height: 32, fontSize: 12, '--pp-hue': hueOf(o.id) }}
                              aria-hidden="true"
                            >
                              {initialsOf(o.name)}
                            </div>
                            <div className="pp-officer-id">
                              <span className="pp-officer-name">{o.name}</span>
                              <span className="ro-officer-meta">
                                <RankInsignia hierarchy={o.rankHierarchy} size={16} title={o.rank} />
                                {o.rankAbbr} · {o.unit}
                              </span>
                            </div>
                          </div>
                        </td>
                        {shifts.map((s, i) => (
                          <td key={days[i].iso} className={days[i].iso === todayIso ? 'ro-today' : ''}>
                            <ShiftChip shiftKey={s} />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination */}
        <div className="cf-pager">
          <span className="cf-pager-info">
            {filtered.length
              ? `${((safePage - 1) * PER_PAGE + 1).toLocaleString()}–${((safePage - 1) * PER_PAGE + pageRows.length).toLocaleString()} of ${filtered.length.toLocaleString()} officers`
              : loading ? '' : '0 officers'}
          </span>
          <div className="cf-pager-controls">
            <button
              className="cf-page-btn"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1 || loading}
            >
              <ChevronLeft size={15} /> Previous
            </button>
            <span className="cf-page-num">Page {safePage} of {totalPages}</span>
            <button
              className="cf-page-btn"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages || loading}
            >
              Next <ChevronRight size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
