import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield, Database, ArrowLeft, Search, X, Sun, Moon,
  ChevronLeft, ChevronRight, ChevronDown, Check, RefreshCw, AlertTriangle,
} from 'lucide-react';
import {
  TABLE_GROUPS, ALL_TABLES, tableLabel, SYSTEM_COLUMNS,
  fetchColumns, fetchPage, fetchCount,
} from '../utils/datastore';

const PER_PAGE_OPTIONS = [25, 50, 100];

// Order columns: ROWID first, business columns next, audit columns last.
function orderColumns(cols) {
  const rowid = cols.filter((c) => c === 'ROWID');
  const sys = cols.filter((c) => SYSTEM_COLUMNS.includes(c));
  const rest = cols.filter((c) => c !== 'ROWID' && !SYSTEM_COLUMNS.includes(c));
  return [...rowid, ...rest, ...sys];
}

function useTheme() {
  const [isDark, setIsDark] = useState(
    () => localStorage.getItem('sentinel-theme') === 'dark'
  );
  useEffect(() => {
    const theme = isDark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('sentinel-theme', theme);
  }, [isDark]);
  return [isDark, setIsDark];
}

export default function CaseFiles() {
  const navigate = useNavigate();
  const [isDark, setIsDark] = useTheme();

  const [activeTable, setActiveTable] = useState(ALL_TABLES[0].name);
  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [hasNext, setHasNext] = useState(false);
  const [total, setTotal] = useState(null);
  const [showSystem, setShowSystem] = useState(false);

  const [filterColumn, setFilterColumn] = useState('ALL');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Table picker (searchable combobox) state.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const pickerRef = useRef(null);

  // Close the picker on outside click or Escape.
  useEffect(() => {
    if (!pickerOpen) return undefined;
    const onDown = (e) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) setPickerOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setPickerOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  const pickTable = (name) => {
    setActiveTable(name);
    setPickerOpen(false);
    setPickerQuery('');
  };

  // Debounce the search box → committed `search` used in queries.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => clearTimeout(id);
  }, [searchInput]);

  // When the table changes, reset paging/filters and load its columns.
  useEffect(() => {
    let cancelled = false;
    setPage(1);
    setSearchInput('');
    setSearch('');
    setFilterColumn('');
    setColumns([]);
    setError(null);
    (async () => {
      try {
        const cols = await fetchColumns(activeTable);
        if (!cancelled) setColumns(orderColumns(cols));
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [activeTable]);

  // Reset to page 1 whenever filter/search/perPage change.
  useEffect(() => { setPage(1); }, [search, filterColumn, perPage]);

  // Default the filter column to the first non-system column once columns load,
  // keeping the current choice if it's still valid.
  useEffect(() => {
    const cols = columns.filter((c) => !SYSTEM_COLUMNS.includes(c));
    setFilterColumn((cur) => (cols.includes(cur) ? cur : cols[0] || ''));
  }, [columns]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [{ rows: r, hasNext: hn }, count] = await Promise.all([
        fetchPage({ table: activeTable, page, perPage, column: filterColumn, search }),
        fetchCount({ table: activeTable, column: filterColumn, search }),
      ]);
      // Derive/refresh columns from data if the sample-row lookup came back empty.
      setRows(r);
      setHasNext(hn);
      setTotal(count);
    } catch (e) {
      setError(e.message || String(e));
      setRows([]);
      setHasNext(false);
    } finally {
      setLoading(false);
    }
  }, [activeTable, page, perPage, filterColumn, search]);

  useEffect(() => { load(); }, [load]);

  // Prefer the sampled column list; fall back to keys from the loaded rows so a
  // freshly-switched table still renders headers before fetchColumns resolves.
  const effectiveColumns = columns.length
    ? columns
    : rows[0]
    ? orderColumns(Object.keys(rows[0]))
    : [];
  const visibleColumns = showSystem
    ? effectiveColumns
    : effectiveColumns.filter((c) => !SYSTEM_COLUMNS.includes(c));

  const totalPages = total != null ? Math.max(1, Math.ceil(total / perPage)) : null;
  const rangeStart = rows.length ? (page - 1) * perPage + 1 : 0;
  const rangeEnd = (page - 1) * perPage + rows.length;

  const fmt = (v) => {
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
  };

  // Filter the grouped table list by the picker's search box.
  const pq = pickerQuery.trim().toLowerCase();
  const pickerGroups = TABLE_GROUPS
    .map((g) => ({
      ...g,
      tables: g.tables.filter(
        (t) => !pq || t.label.toLowerCase().includes(pq) || t.name.toLowerCase().includes(pq)
      ),
    }))
    .filter((g) => g.tables.length);

  return (
    <div className="cf-page">
      {/* ── Header ── */}
      <header className="db-nav-bar">
        <div className="db-nav-brand">
          <Shield size={20} strokeWidth={1.5} className="nav-brand-icon" />
          <span className="nav-brand-name">SENTINEL</span>
          <span className="nav-brand-rule" />
          <span className="nav-brand-sub">Case Files</span>
        </div>
        <button className="cf-back-btn" onClick={() => navigate('/dashboard')}>
          <ArrowLeft size={15} />
          <span>Dashboard</span>
        </button>
        <div className="db-nav-right">
          <button
            className="nav-icon-btn"
            onClick={() => setIsDark((d) => !d)}
            aria-label={isDark ? 'Light mode' : 'Dark mode'}
            title={isDark ? 'Light mode' : 'Dark mode'}
          >
            {isDark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
      </header>

      <div className="cf-body">
        {/* ── Main ── */}
        <main className="cf-main">
          {/* Toolbar */}
          <div className="cf-toolbar">
            <div className="cf-toolbar-title">
              {/* Searchable table picker (combobox) */}
              <div className="cf-picker" ref={pickerRef}>
                <button
                  className={`cf-picker-btn ${pickerOpen ? 'open' : ''}`}
                  onClick={() => setPickerOpen((o) => !o)}
                  aria-haspopup="listbox"
                  aria-expanded={pickerOpen}
                >
                  <Database size={16} className="cf-picker-icon" />
                  <span className="cf-picker-label">{tableLabel(activeTable)}</span>
                  <ChevronDown size={16} className="cf-picker-chevron" />
                </button>

                {pickerOpen && (
                  <div className="cf-picker-pop" role="listbox">
                    <div className="cf-picker-search">
                      <Search size={14} />
                      <input
                        autoFocus
                        placeholder="Search tables…"
                        value={pickerQuery}
                        onChange={(e) => setPickerQuery(e.target.value)}
                      />
                    </div>
                    <div className="cf-picker-list">
                      {pickerGroups.length === 0 ? (
                        <div className="cf-picker-empty">No tables match “{pickerQuery}”</div>
                      ) : (
                        pickerGroups.map((g) => (
                          <div key={g.group} className="cf-picker-group">
                            <div className="cf-picker-group-label">{g.group}</div>
                            {g.tables.map((t) => (
                              <button
                                key={t.name}
                                className={`cf-picker-item ${activeTable === t.name ? 'active' : ''}`}
                                onClick={() => pickTable(t.name)}
                                role="option"
                                aria-selected={activeTable === t.name}
                              >
                                <span>{t.label}</span>
                                {activeTable === t.name && <Check size={14} />}
                              </button>
                            ))}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              <span className="cf-count">
                {total != null
                  ? `${total.toLocaleString()} record${total === 1 ? '' : 's'}`
                  : rows.length
                  ? `${rows.length}+ records`
                  : ''}
              </span>
            </div>

            <div className="cf-toolbar-controls">
              <div className="cf-filter">
                <span className="cf-filter-label">Filter</span>
                <select
                  className="cf-select"
                  value={filterColumn}
                  onChange={(e) => setFilterColumn(e.target.value)}
                  title="Column to filter"
                  disabled={!visibleColumns.length}
                >
                  {visibleColumns.length === 0 && <option value="">—</option>}
                  {visibleColumns.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>

                <div className="cf-search">
                  <Search size={14} className="cf-search-icon" />
                  <input
                    className="cf-search-input"
                    placeholder={filterColumn ? `contains…` : 'no columns'}
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    disabled={!filterColumn}
                  />
                  {searchInput && (
                    <button className="cf-search-clear" onClick={() => setSearchInput('')}>
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>

              <select
                className="cf-select"
                value={perPage}
                onChange={(e) => setPerPage(Number(e.target.value))}
                title="Rows per page"
              >
                {PER_PAGE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n} / page</option>
                ))}
              </select>

              <label className="cf-checkbox" title="Show Catalyst audit columns">
                <input
                  type="checkbox"
                  checked={showSystem}
                  onChange={(e) => setShowSystem(e.target.checked)}
                />
                <span>System cols</span>
              </label>

              <button className="cf-icon-btn" onClick={load} title="Refresh" disabled={loading}>
                <RefreshCw size={15} className={loading ? 'cf-spin' : ''} />
              </button>
            </div>
          </div>

          {/* Data area */}
          <div className="cf-table-wrap">
            {error ? (
              <div className="cf-state cf-error">
                <AlertTriangle size={22} />
                <p>{error}</p>
                <button className="cf-retry" onClick={load}>Retry</button>
              </div>
            ) : loading && !rows.length ? (
              <div className="cf-state">
                <div className="cf-spinner" />
                <p>Loading {tableLabel(activeTable)}…</p>
              </div>
            ) : !rows.length ? (
              <div className="cf-state">
                <Database size={22} />
                <p>{search ? 'No matching records.' : 'No records in this table.'}</p>
              </div>
            ) : (
              <div className="cf-scroll">
                <table className="cf-table">
                  <thead>
                    <tr>
                      {visibleColumns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={row.ROWID || i}>
                        {visibleColumns.map((c) => (
                          <td key={c} title={fmt(row[c])}>{fmt(row[c])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Pagination */}
          <div className="cf-pager">
            <span className="cf-pager-info">
              {rows.length
                ? `${rangeStart.toLocaleString()}–${rangeEnd.toLocaleString()}`
                : '0'}
              {total != null ? ` of ${total.toLocaleString()}` : ''}
            </span>
            <div className="cf-pager-controls">
              <button
                className="cf-page-btn"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
              >
                <ChevronLeft size={15} /> Prev
              </button>
              <span className="cf-page-num">
                Page {page}{totalPages ? ` of ${totalPages}` : ''}
              </span>
              <button
                className="cf-page-btn"
                onClick={() => setPage((p) => p + 1)}
                disabled={!hasNext || loading}
              >
                Next <ChevronRight size={15} />
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
