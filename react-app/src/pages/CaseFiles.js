import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Database, Search, X,
  ChevronLeft, ChevronRight, ChevronDown, Check, RefreshCw, AlertTriangle,
  FileSpreadsheet,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  TABLE_GROUPS, ALL_TABLES, tableLabel, SYSTEM_COLUMNS, FILTER_OPS,
  fetchColumns, fetchPage, fetchCount, fetchAllRows,
} from '../utils/datastore';
import TopBar from '../components/TopBar';

const OP_PLACEHOLDER = {
  contains: 'contains…', '=': 'equals…', '!=': 'not equals…',
  '>': 'greater than…', '>=': 'at least…', '<': 'less than…', '<=': 'at most…',
  starts: 'starts with…', ends: 'ends with…',
};

const PER_PAGE_OPTIONS = [25, 50, 100];

// Windowed page list: 1 … around-current … last, with '…' gaps.
function pageWindow(current, total) {
  if (!total || total <= 1) return [1];
  const wanted = new Set([1, total, current, current - 1, current + 1]);
  const pages = [...wanted].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of pages) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

// Order columns: ROWID first, business columns next, audit columns last.
function orderColumns(cols) {
  const rowid = cols.filter((c) => c === 'ROWID');
  const sys = cols.filter((c) => SYSTEM_COLUMNS.includes(c));
  const rest = cols.filter((c) => c !== 'ROWID' && !SYSTEM_COLUMNS.includes(c));
  return [...rowid, ...rest, ...sys];
}

export default function CaseFiles() {
  const [activeTable, setActiveTable] = useState(ALL_TABLES[0].name);
  const [columns, setColumns] = useState([]);
  const [sampleRow, setSampleRow] = useState({});
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [hasNext, setHasNext] = useState(false);
  const [total, setTotal] = useState(null);
  const [showSystem, setShowSystem] = useState(false);

  const [filterColumn, setFilterColumn] = useState('ALL');
  const [filterOp, setFilterOp] = useState('contains');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Excel export: every table becomes a worksheet in one workbook.
  const [exporting, setExporting] = useState(null); // null | { done, total, table }

  const exportExcel = useCallback(async () => {
    if (exporting) return;
    const wb = XLSX.utils.book_new();
    try {
      for (let i = 0; i < ALL_TABLES.length; i++) {
        const t = ALL_TABLES[i];
        setExporting({ done: i, total: ALL_TABLES.length, table: t.label });
        let rows = [];
        try {
          rows = await fetchAllRows(t.name);
        } catch {
          rows = [{ error: 'export failed for this table' }];
        }
        // Sheet names cap at 31 chars and forbid : \ / ? * [ ]
        const sheet = t.name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31);
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.json_to_sheet(rows.length ? rows : [{}]),
          sheet
        );
      }
      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `sentinel-datastore-${stamp}.xlsx`);
    } finally {
      setExporting(null);
    }
  }, [exporting]);

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
        const { columns: cols, sample } = await fetchColumns(activeTable);
        if (!cancelled) {
          setColumns(orderColumns(cols));
          setSampleRow(sample);
        }
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [activeTable]);

  // Reset to page 1 whenever filter/search/perPage change.
  useEffect(() => { setPage(1); }, [search, filterColumn, filterOp, perPage]);

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
        fetchPage({ table: activeTable, page, perPage, column: filterColumn, search, op: filterOp, sample: sampleRow }),
        fetchCount({ table: activeTable, column: filterColumn, search, op: filterOp, sample: sampleRow }),
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
  }, [activeTable, page, perPage, filterColumn, filterOp, search, sampleRow]);

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
      <TopBar title="Case Files" subtitle="Browse the Data Store" />

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

                <select
                  className="cf-select cf-op-select"
                  value={filterOp}
                  onChange={(e) => setFilterOp(e.target.value)}
                  title="Filter clause"
                  disabled={!filterColumn}
                >
                  {FILTER_OPS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>

                <div className="cf-search">
                  <Search size={14} className="cf-search-icon" />
                  <input
                    className="cf-search-input"
                    placeholder={filterColumn ? OP_PLACEHOLDER[filterOp] : 'no columns'}
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

              <button
                className="cf-export-btn"
                onClick={exportExcel}
                disabled={!!exporting}
                title="Export every table to one Excel workbook (a sheet per table)"
              >
                <FileSpreadsheet size={15} />
                <span>
                  {exporting
                    ? `Exporting ${exporting.done + 1}/${exporting.total}…`
                    : 'Export Excel'}
                </span>
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
                <ChevronLeft size={15} /> Previous
              </button>
              <div className="cf-pages">
                {totalPages ? (
                  pageWindow(page, totalPages).map((p, i) =>
                    p === '…' ? (
                      <span key={`e${i}`} className="cf-page-ellipsis">…</span>
                    ) : (
                      <button
                        key={p}
                        className={`cf-page-num-btn ${p === page ? 'active' : ''}`}
                        onClick={() => setPage(p)}
                        disabled={loading}
                      >
                        {p}
                      </button>
                    )
                  )
                ) : (
                  <span className="cf-page-num">Page {page}</span>
                )}
              </div>
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
