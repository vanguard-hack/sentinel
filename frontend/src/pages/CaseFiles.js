import React, {
  useState, useEffect, useCallback, useRef, useMemo,
} from 'react';
import {
  Database, Search, X,
  ChevronLeft, ChevronRight, ChevronDown, Check, RefreshCw, AlertTriangle,
  FileSpreadsheet, ArrowUp, ArrowDown, ArrowUpDown, Pin, PinOff, EyeOff,
  SlidersHorizontal, MoreHorizontal, Copy, FileDown,
} from 'lucide-react';
import {
  TABLE_GROUPS, ALL_TABLES, tableLabel, SYSTEM_COLUMNS, FILTER_OPS,
  fetchColumns, fetchPage, fetchCount,
} from '../utils/datastore';
import TopBar from '../components/TopBar';
import EmptyState from '../components/ui/EmptyState';
import Skeleton from '../components/ui/Skeleton';
import { useTranslation } from 'react-i18next';
import { useExport } from '../context/ExportContext';

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

const NUM_RE = /^-?\d+(\.\d+)?$/;
const GUTTER_W = 56;
const MIN_COL_W = 72;
const MAX_COL_W = 560;

export default function CaseFiles() {
  const { t } = useTranslation();
  const [activeTable, setActiveTable] = useState(ALL_TABLES[0].name);
  const [columns, setColumns] = useState([]);
  const [sampleRow, setSampleRow] = useState({});
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [hasNext, setHasNext] = useState(false);
  const [total, setTotal] = useState(null);

  const [filterColumn, setFilterColumn] = useState('ALL');
  const [filterOp, setFilterOp] = useState('contains');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // ── Spreadsheet-grade grid state (data-grid interaction model, scoped to a
  // read-only browser: no cell editing, fill handle, or undo — the Data Store
  // is read-only and a page never holds more than 100 rows, so no
  // virtualization either). Sort round-trips to the server like the existing
  // filter; everything else — range selection, keyboard nav, resize, pin,
  // hide, row checks, copy — is client-side over the current page. ──
  const [sort, setSort] = useState([]); // [{ key, dir }], priority order
  const [colWidths, setColWidths] = useState({});
  const [hiddenCols, setHiddenCols] = useState(() => new Set());
  const [pinnedCols, setPinnedCols] = useState([]);
  const [headerMenuFor, setHeaderMenuFor] = useState(null);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [checked, setChecked] = useState(() => new Set()); // ROWIDs, across pages
  const [active, setActive] = useState(null); // { r, c } into (rows, displayColumns)
  const [anchor, setAnchor] = useState(null);
  const [announce, setAnnounce] = useState('');
  const gridRef = useRef(null);
  const draggingRef = useRef(false);
  const selectAllRef = useRef(null);
  const headerMenuRef = useRef(null);
  const columnsMenuRef = useRef(null);
  const rowCacheRef = useRef(new Map()); // ROWID -> row, so bulk actions work across pages

  // Excel export runs as a background job in ExportContext (mounted once,
  // above the router) so switching pages mid-export neither stops it nor
  // loses the progress readout — see that file for why.
  const { exporting, startExport } = useExport();

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

  // Close the per-column and columns menus on outside click or Escape.
  useEffect(() => {
    if (!headerMenuFor && !columnsMenuOpen) return undefined;
    const onDown = (e) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target)) setHeaderMenuFor(null);
      if (columnsMenuRef.current && !columnsMenuRef.current.contains(e.target)) setColumnsMenuOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { setHeaderMenuFor(null); setColumnsMenuOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [headerMenuFor, columnsMenuOpen]);

  // A drag-selection can end with the mouse anywhere on the page, not just
  // over a cell — the window is the only element guaranteed to see mouseup.
  useEffect(() => {
    const onUp = () => { draggingRef.current = false; };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

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

  // When the table changes, reset paging/filters/grid layout and load its columns.
  useEffect(() => {
    let cancelled = false;
    setPage(1);
    setSearchInput('');
    setSearch('');
    setFilterColumn('');
    setColumns([]);
    setError(null);
    setSort([]);
    setColWidths({});
    setHiddenCols(new Set());
    setPinnedCols([]);
    setChecked(new Set());
    setActive(null);
    setAnchor(null);
    rowCacheRef.current.clear();
    (async () => {
      try {
        const { columns: cols, sample } = await fetchColumns(activeTable);
        if (!cancelled) {
          const ordered = orderColumns(cols);
          setColumns(ordered);
          setSampleRow(sample);
          // Default pin, matching the spec: the first column when nothing else claims it.
          const firstVisible = ordered.find((c) => !SYSTEM_COLUMNS.includes(c));
          if (firstVisible) setPinnedCols([firstVisible]);
        }
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [activeTable]);

  // Reset to page 1 whenever filter/search/sort/perPage change.
  useEffect(() => { setPage(1); }, [search, filterColumn, filterOp, perPage, sort]);

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
        fetchPage({
          table: activeTable, page, perPage, column: filterColumn, search, op: filterOp, sample: sampleRow, sort,
        }),
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
  }, [activeTable, page, perPage, filterColumn, filterOp, search, sampleRow, sort]);

  useEffect(() => { load(); }, [load]);

  // Every row that has ever been on screen stays resolvable by ROWID, so a
  // checked row from an earlier page can still be copied or exported.
  useEffect(() => {
    rows.forEach((r) => { if (r && r.ROWID != null) rowCacheRef.current.set(r.ROWID, r); });
  }, [rows]);

  // Prefer the sampled column list; fall back to keys from the loaded rows so a
  // freshly-switched table still renders headers before fetchColumns resolves.
  const effectiveColumns = columns.length
    ? columns
    : rows[0]
    ? orderColumns(Object.keys(rows[0]))
    : [];
  const visibleColumns = effectiveColumns.filter((c) => !SYSTEM_COLUMNS.includes(c));

  // Pinned columns move to the front, in the order they were pinned; the rest
  // keep their schema order. Hidden columns drop out entirely.
  const displayColumns = useMemo(() => {
    const visible = visibleColumns.filter((c) => !hiddenCols.has(c));
    const pinnedSet = new Set(pinnedCols);
    const pinned = pinnedCols.filter((c) => visible.includes(c));
    const rest = visible.filter((c) => !pinnedSet.has(c));
    return [...pinned, ...rest];
  }, [visibleColumns, hiddenCols, pinnedCols]);

  const widthOf = useCallback(
    (c) => colWidths[c] ?? (c === 'ROWID' ? 130 : 160),
    [colWidths],
  );
  const isNumericCol = useCallback((c) => {
    const v = sampleRow?.[c];
    return typeof v === 'number' || (v != null && v !== '' && NUM_RE.test(String(v)));
  }, [sampleRow]);

  const leftOffsets = useMemo(() => {
    const map = {};
    let acc = GUTTER_W;
    displayColumns.filter((c) => pinnedCols.includes(c)).forEach((c) => {
      map[c] = acc;
      acc += widthOf(c);
    });
    return map;
  }, [displayColumns, pinnedCols, widthOf]);

  // Out-of-bounds guard: a filter/sort/table change can shrink the row or
  // column count out from under an existing selection.
  useEffect(() => {
    if (!active) return;
    const maxR = rows.length - 1;
    const maxC = displayColumns.length - 1;
    if (active.r > maxR || active.c > maxC) {
      setActive(null);
      setAnchor(null);
    }
  }, [rows, displayColumns, active]);

  useEffect(() => {
    if (!selectAllRef.current) return;
    const some = rows.some((r) => checked.has(r.ROWID));
    const all = rows.length > 0 && rows.every((r) => checked.has(r.ROWID));
    selectAllRef.current.indeterminate = some && !all;
  }, [rows, checked]);

  const totalPages = total != null ? Math.max(1, Math.ceil(total / perPage)) : null;
  const rangeStart = rows.length ? (page - 1) * perPage + 1 : 0;
  const rangeEnd = (page - 1) * perPage + rows.length;

  const fmt = (v) => {
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
  };
  const rawFmt = (v) => (v === null || v === undefined ? '' : String(v));

  // ── Sort ──
  const sortInfo = (c) => {
    const idx = sort.findIndex((s) => s.key === c);
    return idx === -1 ? null : { dir: sort[idx].dir, priority: idx + 1 };
  };
  const cycleSort = (key, additive) => {
    setSort((prev) => {
      const idx = prev.findIndex((s) => s.key === key);
      if (!additive) {
        if (idx === -1) return [{ key, dir: 'asc' }];
        if (prev[idx].dir === 'asc') return [{ key, dir: 'desc' }];
        return [];
      }
      if (idx === -1) return [...prev, { key, dir: 'asc' }];
      if (prev[idx].dir === 'asc') {
        const next = [...prev];
        next[idx] = { key, dir: 'desc' };
        return next;
      }
      return prev.filter((s) => s.key !== key);
    });
  };

  // ── Column resize / pin / hide ──
  const startResize = (c, e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(c);
    const onMove = (ev) => {
      const w = Math.max(MIN_COL_W, Math.min(MAX_COL_W, startW + (ev.clientX - startX)));
      setColWidths((prev) => ({ ...prev, [c]: w }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const nudgeWidth = (c, delta) => {
    setColWidths((prev) => ({ ...prev, [c]: Math.max(MIN_COL_W, Math.min(MAX_COL_W, widthOf(c) + delta)) }));
  };
  const togglePin = (c) => setPinnedCols((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  const hideCol = (c) => setHiddenCols((prev) => new Set(prev).add(c));
  const showCol = (c) => setHiddenCols((prev) => { const n = new Set(prev); n.delete(c); return n; });

  // ── Row checks ──
  const toggleOne = (id) => setChecked((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toggleSelectAllOnPage = () => {
    const all = rows.length > 0 && rows.every((r) => checked.has(r.ROWID));
    setChecked((prev) => {
      const next = new Set(prev);
      rows.forEach((r) => { if (all) next.delete(r.ROWID); else next.add(r.ROWID); });
      return next;
    });
  };

  // ── Range selection ──
  const inRange = (r, c) => {
    if (!active) return false;
    const a = anchor || active;
    const rMin = Math.min(a.r, active.r), rMax = Math.max(a.r, active.r);
    const cMin = Math.min(a.c, active.c), cMax = Math.max(a.c, active.c);
    return r >= rMin && r <= rMax && c >= cMin && c <= cMax;
  };
  const isActiveCell = (r, c) => !!active && active.r === r && active.c === c;

  const copyRange = () => {
    if (!active) return;
    const a = anchor || active;
    const rMin = Math.min(a.r, active.r), rMax = Math.max(a.r, active.r);
    const cMin = Math.min(a.c, active.c), cMax = Math.max(a.c, active.c);
    const cols = displayColumns.slice(cMin, cMax + 1);
    const lines = [];
    for (let r = rMin; r <= rMax; r += 1) {
      const row = rows[r];
      lines.push(cols.map((c) => rawFmt(row?.[c])).join('\t'));
    }
    const text = lines.join('\n');
    const n = (rMax - rMin + 1) * (cMax - cMin + 1);
    navigator.clipboard?.writeText(text)
      .then(() => setAnnounce(`Copied ${n} cell${n === 1 ? '' : 's'}`))
      .catch(() => setAnnounce('Copy failed'));
  };

  const onGridKeyDown = (e) => {
    if (!rows.length || !displayColumns.length) return;
    const maxR = rows.length - 1;
    const maxC = displayColumns.length - 1;
    const cur = active || { r: 0, c: 0 };
    const meta = e.metaKey || e.ctrlKey;

    const move = (r, c, extend) => {
      const nr = Math.max(0, Math.min(maxR, r));
      const nc = Math.max(0, Math.min(maxC, c));
      setActive({ r: nr, c: nc });
      if (!extend) setAnchor({ r: nr, c: nc });
    };

    if (meta && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setAnchor({ r: 0, c: 0 });
      setActive({ r: maxR, c: maxC });
      return;
    }
    if (meta && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copyRange();
      return;
    }
    if (e.key === ' ' && e.shiftKey && !meta) {
      e.preventDefault();
      const a = anchor || cur;
      const rMin = Math.min(a.r, cur.r), rMax = Math.max(a.r, cur.r);
      setChecked((prev) => {
        const next = new Set(prev);
        for (let i = rMin; i <= rMax; i += 1) {
          const id = rows[i]?.ROWID;
          if (id == null) continue;
          if (next.has(id)) next.delete(id); else next.add(id);
        }
        return next;
      });
      return;
    }
    if (e.key === ' ' && meta) {
      e.preventDefault();
      setAnchor({ r: 0, c: cur.c });
      setActive({ r: maxR, c: cur.c });
      return;
    }

    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(cur.r + 1, cur.c, e.shiftKey); break;
      case 'ArrowUp': e.preventDefault(); move(cur.r - 1, cur.c, e.shiftKey); break;
      case 'ArrowLeft': e.preventDefault(); move(cur.r, cur.c - 1, e.shiftKey); break;
      case 'ArrowRight': e.preventDefault(); move(cur.r, cur.c + 1, e.shiftKey); break;
      case 'PageDown': e.preventDefault(); move(maxR, cur.c, e.shiftKey); break;
      case 'PageUp': e.preventDefault(); move(0, cur.c, e.shiftKey); break;
      case 'Home':
        e.preventDefault();
        if (meta) move(0, 0, e.shiftKey); else move(cur.r, 0, e.shiftKey);
        break;
      case 'End':
        e.preventDefault();
        if (meta) move(maxR, maxC, e.shiftKey); else move(cur.r, maxC, e.shiftKey);
        break;
      case 'Escape':
        if (anchor && (anchor.r !== cur.r || anchor.c !== cur.c)) setAnchor(cur);
        else if (checked.size) setChecked(new Set());
        break;
      default:
        break;
    }
  };

  // ── Bulk actions on checked rows (resolved through the row cache, so a row
  // checked on an earlier page still copies/exports correctly). ──
  const checkedRows = () => [...checked].map((id) => rowCacheRef.current.get(id)).filter(Boolean);
  const copyChecked = () => {
    const rowsForIds = checkedRows();
    const header = displayColumns.join('\t');
    const lines = rowsForIds.map((r) => displayColumns.map((c) => rawFmt(r[c])).join('\t'));
    navigator.clipboard?.writeText([header, ...lines].join('\n'))
      .then(() => setAnnounce(`Copied ${rowsForIds.length} row${rowsForIds.length === 1 ? '' : 's'}`))
      .catch(() => setAnnounce('Copy failed'));
  };
  const exportChecked = () => {
    const rowsForIds = checkedRows();
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [displayColumns.map(esc).join(',')];
    rowsForIds.forEach((r) => lines.push(displayColumns.map((c) => esc(r[c])).join(',')));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tableLabel(activeTable).toLowerCase().replace(/\s+/g, '-')}-selected.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setAnnounce(`Exported ${rowsForIds.length} row${rowsForIds.length === 1 ? '' : 's'}`);
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
      <TopBar title={t('pages.caseFiles')} subtitle={t('pages.caseFilesSub')}>
        {/* Runs as a background job (ExportContext) — moved to the
            rightmost end of the page, the one spot that survives switching
            to another section while it is still running. */}
        <button
          className="cf-export-btn"
          onClick={startExport}
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
      </TopBar>

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

              <div className="cf-picker" ref={columnsMenuRef}>
                <button
                  className="cf-icon-btn"
                  onClick={() => setColumnsMenuOpen((o) => !o)}
                  title="Show or hide columns"
                  aria-haspopup="menu"
                  aria-expanded={columnsMenuOpen}
                >
                  <SlidersHorizontal size={15} />
                </button>
                {columnsMenuOpen && (
                  <div className="cfg-colsmenu" role="menu">
                    {visibleColumns.length === 0 && <div className="cf-picker-empty">No columns</div>}
                    {visibleColumns.map((c) => (
                      <label key={c} className="cfg-colsmenu-row">
                        <input
                          type="checkbox"
                          checked={!hiddenCols.has(c)}
                          onChange={() => (hiddenCols.has(c) ? showCol(c) : hideCol(c))}
                        />
                        <span>{c}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <button className="cf-icon-btn" onClick={load} title="Refresh" disabled={loading}>
                <RefreshCw size={15} className={loading ? 'cf-spin' : ''} />
              </button>
            </div>
          </div>

          {checked.size > 0 && (
            <div className="cfg-bulkbar" role="toolbar" aria-label="Checked rows">
              <span>{checked.size.toLocaleString()} row{checked.size === 1 ? '' : 's'} selected</span>
              <div className="cfg-bulkbar-actions">
                <button type="button" className="aa-btn" onClick={copyChecked}>
                  <Copy size={14} /> <span>Copy</span>
                </button>
                <button type="button" className="aa-btn" onClick={exportChecked}>
                  <FileDown size={14} /> <span>Export CSV</span>
                </button>
                <button type="button" className="aa-btn" onClick={() => setChecked(new Set())}>
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* Data area */}
          <div className="cf-table-wrap">
            {error ? (
              <div className="cf-state cf-error">
                <AlertTriangle size={22} />
                <p>{error}</p>
                <button className="cf-retry" onClick={load}>Retry</button>
              </div>
            ) : loading && !rows.length ? (
              <div className="cf-scroll">
                <table className="cf-table cfg-fixed" aria-hidden="true">
                  <thead>
                    <tr>
                      <th className="cfg-gutter-head" />
                      {(displayColumns.length ? displayColumns : Array.from({ length: 6 })).map((c, i) => (
                        <th key={c || i}><Skeleton variant="text" width="60%" height={11} /></th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 8 }).map((_, r) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <tr key={r}>
                        <th scope="row" className="cfg-gutter" />
                        {(displayColumns.length ? displayColumns : Array.from({ length: 6 })).map((c, i) => (
                          // eslint-disable-next-line react/no-array-index-key
                          <td key={c || i}><Skeleton variant="text" width={`${50 + ((r * 7 + i * 13) % 40)}%`} height={12} /></td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : !rows.length ? (
              <EmptyState
                type={search ? 'no-results' : 'no-data'}
                description={search ? 'No record matches that search.' : 'This table has no rows.'}
                actionLabel={search ? 'Clear filters' : undefined}
                onAction={search ? () => setSearchInput('') : undefined}
              />
            ) : (
              <div className="cf-scroll">
                <table
                  ref={gridRef}
                  className="cf-table cfg-fixed"
                  role="grid"
                  aria-label={`${tableLabel(activeTable)} records`}
                  aria-multiselectable="true"
                  aria-rowcount={total != null ? total + 1 : -1}
                  aria-colcount={displayColumns.length + 1}
                  aria-busy={loading}
                  tabIndex={0}
                  aria-activedescendant={active ? `cfg-cell-${active.r}-${active.c}` : undefined}
                  onKeyDown={onGridKeyDown}
                >
                  <thead>
                    <tr>
                      <th className="cfg-gutter-head" scope="col">
                        <input
                          ref={selectAllRef}
                          type="checkbox"
                          checked={rows.length > 0 && rows.every((r) => checked.has(r.ROWID))}
                          onChange={toggleSelectAllOnPage}
                          aria-label="Select all rows on this page"
                        />
                      </th>
                      {displayColumns.map((c, ci) => {
                        const info = sortInfo(c);
                        const pinned = pinnedCols.includes(c);
                        return (
                          <th
                            key={c}
                            scope="col"
                            className={`cfg-th${pinned ? ' cfg-pinned' : ''}`}
                            style={{ width: widthOf(c), ...(pinned ? { left: leftOffsets[c] } : {}) }}
                            aria-sort={info ? (info.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                            aria-colindex={ci + 2}
                          >
                            <div className="cfg-th-inner">
                              <button
                                type="button"
                                className="cfg-sortbtn"
                                onClick={(e) => cycleSort(c, e.shiftKey)}
                                onKeyDown={(e) => {
                                  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                                    e.preventDefault();
                                    nudgeWidth(c, e.key === 'ArrowRight' ? 16 : -16);
                                  }
                                }}
                                title={`Sort by ${c}${sort.length ? '. Shift-click to add as a secondary sort key' : ''}. Alt+Left/Right resizes.`}
                              >
                                <span>{c}</span>
                                {info
                                  ? (info.dir === 'asc'
                                    ? <ArrowUp size={11} className="cfg-sort-icon active" />
                                    : <ArrowDown size={11} className="cfg-sort-icon active" />)
                                  : <ArrowUpDown size={11} className="cfg-sort-icon" />}
                                {sort.length > 1 && info && <span className="cfg-sort-priority">{info.priority}</span>}
                              </button>
                              <button
                                type="button"
                                className="cfg-menubtn"
                                onClick={(e) => { e.stopPropagation(); setHeaderMenuFor(headerMenuFor === c ? null : c); }}
                                aria-haspopup="menu"
                                aria-expanded={headerMenuFor === c}
                                aria-label={`${c} column options`}
                              >
                                <MoreHorizontal size={13} />
                              </button>
                            </div>
                            {headerMenuFor === c && (
                              <div className="cfg-colmenu" ref={headerMenuRef} role="menu">
                                <button type="button" role="menuitem" onClick={() => { togglePin(c); setHeaderMenuFor(null); }}>
                                  {pinned ? <PinOff size={13} /> : <Pin size={13} />}
                                  {pinned ? 'Unpin' : 'Pin to left'}
                                </button>
                                <button type="button" role="menuitem" onClick={() => { hideCol(c); setHeaderMenuFor(null); }}>
                                  <EyeOff size={13} /> Hide column
                                </button>
                              </div>
                            )}
                            <div
                              className="cfg-resize-handle"
                              onMouseDown={(e) => startResize(c, e)}
                              role="separator"
                              aria-orientation="vertical"
                              aria-label={`Resize ${c} column`}
                              tabIndex={-1}
                            />
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, r) => (
                      <tr key={row.ROWID || r} aria-rowindex={r + 2} aria-selected={checked.has(row.ROWID)}>
                        <th scope="row" className="cfg-gutter">
                          <span className="cfg-rownum">{(page - 1) * perPage + r + 1}</span>
                          <input
                            type="checkbox"
                            checked={checked.has(row.ROWID)}
                            onChange={() => toggleOne(row.ROWID)}
                            aria-label={`Select row ${(page - 1) * perPage + r + 1}`}
                          />
                        </th>
                        {displayColumns.map((c, ci) => {
                          const numeric = isNumericCol(c);
                          const pinned = pinnedCols.includes(c);
                          return (
                            <td
                              key={c}
                              id={`cfg-cell-${r}-${ci}`}
                              role="gridcell"
                              aria-colindex={ci + 2}
                              aria-selected={inRange(r, ci)}
                              aria-readonly="true"
                              title={fmt(row[c])}
                              className={[
                                'cfg-cell',
                                c === 'ROWID' ? 'cf-rowid-cell' : '',
                                numeric ? 'num' : '',
                                pinned ? 'cfg-pinned' : '',
                                inRange(r, ci) ? 'in-range' : '',
                                isActiveCell(r, ci) ? 'active-cell' : '',
                              ].filter(Boolean).join(' ')}
                              style={{ width: widthOf(c), ...(pinned ? { left: leftOffsets[c] } : {}) }}
                              onMouseDown={(e) => {
                                // preventScroll: focusing the grid must not scroll it —
                                // a scroll-into-view shifts cells under a stationary
                                // cursor, and Chrome then fires a phantom mouseenter on
                                // whatever cell lands there, extending a plain click
                                // into a multi-row range.
                                gridRef.current?.focus({ preventScroll: true });
                                setActive({ r, c: ci });
                                setAnchor(e.shiftKey && anchor ? anchor : { r, c: ci });
                                draggingRef.current = true;
                              }}
                              onMouseEnter={() => { if (draggingRef.current) setActive({ r, c: ci }); }}
                            >
                              {fmt(row[c])}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Announced to assistive tech only — sort, copy, and export confirmations. */}
          <div className="cfg-sr-only" aria-live="polite">{announce}</div>

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
