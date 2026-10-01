import React, {
  useState, useEffect, useCallback, useRef, useMemo,
} from 'react';
import {
  Database, Search, X, ChevronDown, Check, RefreshCw, AlertTriangle,
  FileSpreadsheet, ArrowUp, ArrowDown, ArrowUpDown, Pin, PinOff, EyeOff,
  Columns3, MoreHorizontal, Copy, FileDown, Undo2, Redo2, Filter as FilterIcon,
  Rows3,
} from 'lucide-react';
import {
  TABLE_GROUPS, ALL_TABLES, tableLabel, SYSTEM_COLUMNS, FILTER_OPS, pageQuery,
} from '../utils/datastore';
import { csvCell, neutralizeFormula } from '../utils/csv';
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
const LOAD_CAP = 50000; // matches pageQuery's own ceiling — honest via `truncated` below
const OVERSCAN = 10;
const ROW_H = { compact: 32, standard: 40, comfortable: 48 }; // exact values the data-grid spec documents

const CMP_OPS = new Set(['>', '>=', '<', '<=']);
// Client-side mirror of what the old server WHERE clause did — same
// operators, same case-insensitive feel for text — now run in the browser
// over the fully loaded table instead of round-tripping to Data Store.
function matchesFilter(value, op, query, numeric) {
  const v = value == null ? '' : String(value);
  if (numeric) {
    const n = Number(value);
    const q = Number(query);
    if (Number.isNaN(q)) return false;
    if (op === '=') return n === q;
    if (op === '!=') return n !== q;
    if (CMP_OPS.has(op)) return op === '>' ? n > q : op === '>=' ? n >= q : op === '<' ? n < q : n <= q;
    return String(n).includes(query);
  }
  const lv = v.toLowerCase();
  const lq = query.toLowerCase();
  if (op === '=') return lv === lq;
  if (op === '!=') return lv !== lq;
  if (op === 'starts') return lv.startsWith(lq);
  if (op === 'ends') return lv.endsWith(lq);
  if (CMP_OPS.has(op)) return op === '>' ? lv > lq : op === '>=' ? lv >= lq : op === '<' ? lv < lq : lv <= lq;
  return lv.includes(lq);
}

// Spreadsheet-style column header: A, B, …, Z, AA, AB, … — used only in the
// status bar's cell reference, so officers used to Excel/Sheets can orient
// themselves the same way they would there.
function colLetters(n) {
  let s = '';
  let i = n;
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

export default function CaseFiles() {
  const { t } = useTranslation();
  const [activeTable, setActiveTable] = useState(ALL_TABLES[0].name);
  const [columns, setColumns] = useState([]);
  const [sampleRow, setSampleRow] = useState({});
  const [allRows, setAllRows] = useState(null); // null = loading; else full table (array), .truncated/.cap set
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [filterColumn, setFilterColumn] = useState('');
  const [filterOp, setFilterOp] = useState('contains');
  const [filterInput, setFilterInput] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  // ── Spreadsheet-grade grid state. Sort and filter run entirely client-side
  // over the fully loaded table (see `allRows`) — Data Store is read-only
  // here, so there's nothing to write back, and the grid matches the uiarc
  // data-grid reference: no pagination UI, a single virtualized scroll
  // through every row. No cell editing or fill handle, for the same reason;
  // Undo/Redo below covers grid LAYOUT (sort, column width/pin/hide), the one
  // thing in this screen that is actually ever "changed". ──
  const [sort, setSort] = useState([]); // [{ key, dir }], priority order
  const [density, setDensity] = useState('standard');
  const [colWidths, setColWidths] = useState({});
  const [hiddenCols, setHiddenCols] = useState(() => new Set());
  const [pinnedCols, setPinnedCols] = useState([]);
  const [headerMenuFor, setHeaderMenuFor] = useState(null);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [checked, setChecked] = useState(() => new Set()); // ROWIDs
  const [active, setActive] = useState(null); // { r, c } — r is an ABSOLUTE row index into the filtered/sorted set
  const [anchor, setAnchor] = useState(null);
  const [announce, setAnnounce] = useState('');
  const gridRef = useRef(null);
  const scrollRef = useRef(null);
  const draggingRef = useRef(false);
  const selectAllRef = useRef(null);
  const headerMenuRef = useRef(null);
  const columnsMenuRef = useRef(null);
  const rowCacheRef = useRef(new Map());

  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const layoutSnapshot = useCallback(
    () => ({ sort, colWidths, hiddenCols: new Set(hiddenCols), pinnedCols: [...pinnedCols] }),
    [sort, colWidths, hiddenCols, pinnedCols],
  );
  const pushHistory = useCallback(() => {
    setHistory((h) => [...h, layoutSnapshot()]);
    setFuture([]);
  }, [layoutSnapshot]);
  const applySnapshot = (snap) => {
    setSort(snap.sort);
    setColWidths(snap.colWidths);
    setHiddenCols(snap.hiddenCols);
    setPinnedCols(snap.pinnedCols);
  };
  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      setFuture((f) => [layoutSnapshot(), ...f]);
      applySnapshot(prev);
      return h.slice(0, -1);
    });
  };
  const redo = () => {
    setFuture((f) => {
      if (!f.length) return f;
      const next = f[0];
      setHistory((h) => [...h, layoutSnapshot()]);
      applySnapshot(next);
      return f.slice(1);
    });
  };

  const { exporting, startExport } = useExport();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const pickerRef = useRef(null);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const onDown = (e) => { if (pickerRef.current && !pickerRef.current.contains(e.target)) setPickerOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setPickerOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [pickerOpen]);

  useEffect(() => {
    if (!headerMenuFor && !columnsMenuOpen) return undefined;
    const onDown = (e) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target)) setHeaderMenuFor(null);
      if (columnsMenuRef.current && !columnsMenuRef.current.contains(e.target)) setColumnsMenuOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { setHeaderMenuFor(null); setColumnsMenuOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [headerMenuFor, columnsMenuOpen]);

  useEffect(() => {
    const onUp = () => { draggingRef.current = false; };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  const pickTable = (name) => { setActiveTable(name); setPickerOpen(false); setPickerQuery(''); };

  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(id);
  }, [searchInput]);
  useEffect(() => {
    const id = setTimeout(() => setFilterValue(filterInput.trim()), 250);
    return () => clearTimeout(id);
  }, [filterInput]);

  // When the table changes, reset everything and load the whole thing once.
  useEffect(() => {
    let cancelled = false;
    setSearchInput(''); setSearch('');
    setFilterColumn(''); setFilterInput(''); setFilterValue(''); setFilterOpen(false);
    setColumns([]);
    setError(null);
    setAllRows(null);
    setSort([]); setColWidths({}); setHiddenCols(new Set()); setPinnedCols([]);
    setHistory([]); setFuture([]);
    setChecked(new Set()); setActive(null); setAnchor(null);
    rowCacheRef.current.clear();
    setLoading(true);
    (async () => {
      try {
        const rows = await pageQuery(`SELECT * FROM ${activeTable}`, activeTable, { cap: LOAD_CAP });
        if (cancelled) return;
        const cols = rows[0] ? orderColumns(Object.keys(rows[0])) : [];
        setColumns(cols);
        setSampleRow(rows[0] || {});
        const firstVisible = cols.find((c) => !SYSTEM_COLUMNS.includes(c));
        if (firstVisible) setPinnedCols([firstVisible]);
        setAllRows(rows);
      } catch (e) {
        if (!cancelled) { setError(e.message || String(e)); setAllRows([]); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTable]);

  useEffect(() => {
    const cols = columns.filter((c) => !SYSTEM_COLUMNS.includes(c));
    setFilterColumn((cur) => (cols.includes(cur) ? cur : cols[0] || ''));
  }, [columns]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await pageQuery(`SELECT * FROM ${activeTable}`, activeTable, { cap: LOAD_CAP, cache: false });
      setAllRows(rows);
      setSampleRow(rows[0] || {});
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [activeTable]);

  useEffect(() => {
    (allRows || []).forEach((r) => { if (r && r.ROWID != null) rowCacheRef.current.set(r.ROWID, r); });
  }, [allRows]);

  const effectiveColumns = columns.length
    ? columns
    : allRows?.[0] ? orderColumns(Object.keys(allRows[0])) : [];
  const visibleColumns = effectiveColumns.filter((c) => !SYSTEM_COLUMNS.includes(c));

  const displayColumns = useMemo(() => {
    const visible = visibleColumns.filter((c) => !hiddenCols.has(c));
    const pinnedSet = new Set(pinnedCols);
    const pinned = pinnedCols.filter((c) => visible.includes(c));
    const rest = visible.filter((c) => !pinnedSet.has(c));
    return [...pinned, ...rest];
  }, [visibleColumns, hiddenCols, pinnedCols]);

  const widthOf = useCallback((c) => colWidths[c] ?? (c === 'ROWID' ? 130 : 160), [colWidths]);
  const isNumericCol = useCallback((c) => {
    const v = sampleRow?.[c];
    return typeof v === 'number' || (v != null && v !== '' && NUM_RE.test(String(v)));
  }, [sampleRow]);

  const leftOffsets = useMemo(() => {
    const map = {};
    let acc = GUTTER_W;
    displayColumns.filter((c) => pinnedCols.includes(c)).forEach((c) => { map[c] = acc; acc += widthOf(c); });
    return map;
  }, [displayColumns, pinnedCols, widthOf]);

  // ── Client-side search + filter + sort, over the whole loaded table. ──
  const filteredSorted = useMemo(() => {
    if (!allRows) return [];
    let rows = allRows;
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((row) => visibleColumns.some((c) => String(row[c] ?? '').toLowerCase().includes(q)));
    }
    if (filterColumn && filterValue) {
      const numeric = isNumericCol(filterColumn);
      rows = rows.filter((row) => matchesFilter(row[filterColumn], filterOp, filterValue, numeric));
    }
    if (sort.length) {
      rows = [...rows].sort((a, b) => {
        for (const s of sort) {
          const av = a[s.key]; const bv = b[s.key];
          const aEmpty = av == null || av === '';
          const bEmpty = bv == null || bv === '';
          if (aEmpty && bEmpty) continue;
          if (aEmpty) return 1;   // empty sinks to the bottom either way
          if (bEmpty) return -1;
          let cmp;
          if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
          else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
          if (cmp !== 0) return s.dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    }
    return rows;
  }, [allRows, search, filterColumn, filterValue, filterOp, sort, visibleColumns, isNumericCol]);

  // ── Virtualization: only the rows a scroll position can actually show,
  // plus a little overscan, render as real <tr> elements. Everything else is
  // two spacer rows whose height stands in for the rows it represents — the
  // same trick a skeleton uses to hold a layout's geometry. ──
  const rowH = ROW_H[density];
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => { const h = entries[0]?.contentRect?.height; if (h) setViewportH(h); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const total = filteredSorted.length;
  const startIdx = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const endIdx = Math.min(total, Math.ceil((scrollTop + viewportH) / rowH) + OVERSCAN);
  const visibleRows = filteredSorted.slice(startIdx, endIdx);
  const topPad = startIdx * rowH;
  const bottomPad = (total - endIdx) * rowH;

  // Keyboard-driven movement can land outside the current scroll window —
  // follow it, the way a spreadsheet keeps the active cell on screen.
  useEffect(() => {
    if (!active || !scrollRef.current) return;
    const el = scrollRef.current;
    const rowTop = active.r * rowH;
    const rowBottom = rowTop + rowH;
    if (rowTop < el.scrollTop) el.scrollTop = rowTop;
    else if (rowBottom > el.scrollTop + viewportH) el.scrollTop = rowBottom - viewportH;
  }, [active, rowH, viewportH]);

  useEffect(() => {
    if (!active) return;
    if (active.r > total - 1 || active.c > displayColumns.length - 1) { setActive(null); setAnchor(null); }
  }, [active, total, displayColumns]);

  useEffect(() => {
    if (!selectAllRef.current) return;
    const rows = visibleRows;
    const some = rows.some((r) => checked.has(r.ROWID));
    const all = rows.length > 0 && rows.every((r) => checked.has(r.ROWID));
    selectAllRef.current.indeterminate = some && !all;
  }, [visibleRows, checked]);

  const fmt = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
  const rawFmt = (v) => neutralizeFormula(v === null || v === undefined ? '' : v);

  // ── Sort ──
  const sortInfo = (c) => { const idx = sort.findIndex((s) => s.key === c); return idx === -1 ? null : { dir: sort[idx].dir, priority: idx + 1 }; };
  const cycleSort = (key, additive) => {
    pushHistory();
    setSort((prev) => {
      const idx = prev.findIndex((s) => s.key === key);
      if (!additive) {
        if (idx === -1) return [{ key, dir: 'asc' }];
        if (prev[idx].dir === 'asc') return [{ key, dir: 'desc' }];
        return [];
      }
      if (idx === -1) return [...prev, { key, dir: 'asc' }];
      if (prev[idx].dir === 'asc') { const next = [...prev]; next[idx] = { key, dir: 'desc' }; return next; }
      return prev.filter((s) => s.key !== key);
    });
  };

  // ── Column resize / pin / hide ──
  const startResize = (c, e) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(c);
    let snapped = false;
    const onMove = (ev) => {
      if (!snapped) { pushHistory(); snapped = true; }
      const w = Math.max(MIN_COL_W, Math.min(MAX_COL_W, startW + (ev.clientX - startX)));
      setColWidths((prev) => ({ ...prev, [c]: w }));
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const nudgeWidth = (c, delta) => {
    pushHistory();
    setColWidths((prev) => ({ ...prev, [c]: Math.max(MIN_COL_W, Math.min(MAX_COL_W, widthOf(c) + delta)) }));
  };
  const togglePin = (c) => { pushHistory(); setPinnedCols((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c])); };
  const hideCol = (c) => { pushHistory(); setHiddenCols((prev) => new Set(prev).add(c)); };
  const showCol = (c) => { pushHistory(); setHiddenCols((prev) => { const n = new Set(prev); n.delete(c); return n; }); };

  // ── Row checks ──
  const toggleOne = (id) => setChecked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleSelectAllOnPage = () => {
    const rows = visibleRows;
    const all = rows.length > 0 && rows.every((r) => checked.has(r.ROWID));
    setChecked((prev) => { const next = new Set(prev); rows.forEach((r) => { if (all) next.delete(r.ROWID); else next.add(r.ROWID); }); return next; });
  };

  // ── Range selection ──
  const inRange = (r, c) => {
    if (!active) return false;
    const a = anchor || active;
    return r >= Math.min(a.r, active.r) && r <= Math.max(a.r, active.r) && c >= Math.min(a.c, active.c) && c <= Math.max(a.c, active.c);
  };
  const isActiveCell = (r, c) => !!active && active.r === r && active.c === c;

  const copyRange = () => {
    if (!active) return;
    const a = anchor || active;
    const rMin = Math.min(a.r, active.r), rMax = Math.max(a.r, active.r);
    const cMin = Math.min(a.c, active.c), cMax = Math.max(a.c, active.c);
    const cols = displayColumns.slice(cMin, cMax + 1);
    const lines = [];
    for (let r = rMin; r <= rMax; r += 1) lines.push(cols.map((c) => rawFmt(filteredSorted[r]?.[c])).join('\t'));
    const n = (rMax - rMin + 1) * (cMax - cMin + 1);
    navigator.clipboard?.writeText(lines.join('\n'))
      .then(() => setAnnounce(`Copied ${n} cell${n === 1 ? '' : 's'}`))
      .catch(() => setAnnounce('Copy failed'));
  };

  const onGridKeyDown = (e) => {
    if (!total || !displayColumns.length) return;
    const maxR = total - 1;
    const maxC = displayColumns.length - 1;
    const cur = active || { r: 0, c: 0 };
    const meta = e.metaKey || e.ctrlKey;
    const move = (r, c, extend) => {
      const nr = Math.max(0, Math.min(maxR, r));
      const nc = Math.max(0, Math.min(maxC, c));
      setActive({ r: nr, c: nc });
      if (!extend) setAnchor({ r: nr, c: nc });
    };
    if (meta && e.key.toLowerCase() === 'a') { e.preventDefault(); setAnchor({ r: 0, c: 0 }); setActive({ r: maxR, c: maxC }); return; }
    if (meta && e.key.toLowerCase() === 'c') { e.preventDefault(); copyRange(); return; }
    if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === ' ' && e.shiftKey && !meta) {
      e.preventDefault();
      const a = anchor || cur;
      const rMin = Math.min(a.r, cur.r), rMax = Math.max(a.r, cur.r);
      setChecked((prev) => {
        const next = new Set(prev);
        for (let i = rMin; i <= rMax; i += 1) { const id = filteredSorted[i]?.ROWID; if (id == null) continue; if (next.has(id)) next.delete(id); else next.add(id); }
        return next;
      });
      return;
    }
    if (e.key === ' ' && meta) { e.preventDefault(); setAnchor({ r: 0, c: cur.c }); setActive({ r: maxR, c: cur.c }); return; }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(cur.r + 1, cur.c, e.shiftKey); break;
      case 'ArrowUp': e.preventDefault(); move(cur.r - 1, cur.c, e.shiftKey); break;
      case 'ArrowLeft': e.preventDefault(); move(cur.r, cur.c - 1, e.shiftKey); break;
      case 'ArrowRight': e.preventDefault(); move(cur.r, cur.c + 1, e.shiftKey); break;
      case 'PageDown': e.preventDefault(); move(cur.r + Math.floor(viewportH / rowH), cur.c, e.shiftKey); break;
      case 'PageUp': e.preventDefault(); move(cur.r - Math.floor(viewportH / rowH), cur.c, e.shiftKey); break;
      case 'Home': e.preventDefault(); if (meta) move(0, 0, e.shiftKey); else move(cur.r, 0, e.shiftKey); break;
      case 'End': e.preventDefault(); if (meta) move(maxR, maxC, e.shiftKey); else move(cur.r, maxC, e.shiftKey); break;
      case 'Escape':
        if (anchor && (anchor.r !== cur.r || anchor.c !== cur.c)) setAnchor(cur);
        else if (checked.size) setChecked(new Set());
        break;
      default: break;
    }
  };

  // ── Bulk actions on checked rows ──
  const checkedRows = () => [...checked].map((id) => rowCacheRef.current.get(id)).filter(Boolean);
  const copyChecked = () => {
    const rows = checkedRows();
    const header = displayColumns.join('\t');
    const lines = rows.map((r) => displayColumns.map((c) => rawFmt(r[c])).join('\t'));
    navigator.clipboard?.writeText([header, ...lines].join('\n'))
      .then(() => setAnnounce(`Copied ${rows.length} row${rows.length === 1 ? '' : 's'}`))
      .catch(() => setAnnounce('Copy failed'));
  };
  const downloadCsv = (rows, suffix) => {
    const lines = [displayColumns.map(csvCell).join(',')];
    rows.forEach((r) => lines.push(displayColumns.map((c) => csvCell(r[c])).join(',')));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tableLabel(activeTable).toLowerCase().replace(/\s+/g, '-')}-${suffix}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const exportChecked = () => { const rows = checkedRows(); downloadCsv(rows, 'selected'); setAnnounce(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'}`); };
  const exportView = () => { downloadCsv(filteredSorted, 'export'); setAnnounce(`Exported ${filteredSorted.length} row${filteredSorted.length === 1 ? '' : 's'}`); };

  // ── Totals row: a sum per numeric column, over the filtered view. ──
  // Every ID/date-suffixed column in this schema is numeric but not a
  // measure — summing a row of auto-increment ids produces a number that
  // looks like a bug, not a total. Sum only columns that are neither.
  const isMeasureCol = useCallback((c) => (
    isNumericCol(c) && c !== 'ROWID' && !/(id|no|date)$/i.test(c)
  ), [isNumericCol]);
  const totals = useMemo(() => {
    const out = {};
    displayColumns.forEach((c) => {
      if (!isMeasureCol(c)) return;
      let sum = 0;
      filteredSorted.forEach((r) => { const v = Number(r[c]); if (!Number.isNaN(v)) sum += v; });
      out[c] = sum;
    });
    return out;
  }, [displayColumns, filteredSorted, isMeasureCol]);
  const compactNum = (n) => {
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
    return n.toLocaleString();
  };

  const pq = pickerQuery.trim().toLowerCase();
  const pickerGroups = TABLE_GROUPS
    .map((g) => ({ ...g, tables: g.tables.filter((tb) => !pq || tb.label.toLowerCase().includes(pq) || tb.name.toLowerCase().includes(pq)) }))
    .filter((g) => g.tables.length);

  const cellRef = active ? `${colLetters(active.c)}${active.r + 1}` : '';
  const selCount = active ? (Math.abs(active.r - (anchor || active).r) + 1) * (Math.abs(active.c - (anchor || active).c) + 1) : 0;

  return (
    <div className="cf-page">
      <TopBar title={t('pages.caseFiles')} subtitle={t('pages.caseFilesSub')}>
        <button
          className="cf-export-btn"
          onClick={startExport}
          disabled={!!exporting}
          title="Export every table to one Excel workbook (a sheet per table)"
        >
          <FileSpreadsheet size={15} />
          <span>{exporting ? `Exporting ${exporting.done + 1}/${exporting.total}…` : 'Export Excel'}</span>
        </button>
      </TopBar>

      <div className="cf-body">
        <main className="cf-main">
          <div className="cf-picker-row">
            <div className="cf-picker" ref={pickerRef}>
              <button className={`cf-picker-btn ${pickerOpen ? 'open' : ''}`} onClick={() => setPickerOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={pickerOpen}>
                <Database size={16} className="cf-picker-icon" />
                <span className="cf-picker-label">{tableLabel(activeTable)}</span>
                <ChevronDown size={16} className="cf-picker-chevron" />
              </button>
              {pickerOpen && (
                <div className="cf-picker-pop" role="listbox">
                  <div className="cf-picker-search">
                    <Search size={14} />
                    <input autoFocus placeholder="Search tables…" value={pickerQuery} onChange={(e) => setPickerQuery(e.target.value)} />
                  </div>
                  <div className="cf-picker-list">
                    {pickerGroups.length === 0 ? (
                      <div className="cf-picker-empty">No tables match “{pickerQuery}”</div>
                    ) : pickerGroups.map((g) => (
                      <div key={g.group} className="cf-picker-group">
                        <div className="cf-picker-group-label">{g.group}</div>
                        {g.tables.map((tb) => (
                          <button key={tb.name} className={`cf-picker-item ${activeTable === tb.name ? 'active' : ''}`} onClick={() => pickTable(tb.name)} role="option" aria-selected={activeTable === tb.name}>
                            <span>{tb.label}</span>
                            {activeTable === tb.name && <Check size={14} />}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {allRows?.truncated && (
              <span className="cf-truncated" title={`Showing the first ${LOAD_CAP.toLocaleString()} rows`}>
                <AlertTriangle size={13} /> Showing first {LOAD_CAP.toLocaleString()}
              </span>
            )}
          </div>

          {/* ── Grid toolbar — matches the reference data-grid's own chrome:
              search + row count on the left, undo/redo, filter, columns,
              density and export on the right. ── */}
          <div className="cfg-toolbar">
            <div className="cfg-search">
              <Search size={14} className="cfg-search-icon" />
              <input
                className="cfg-search-input"
                placeholder="Search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              {searchInput && (
                <button className="cfg-search-clear" onClick={() => setSearchInput('')} aria-label="Clear search">
                  <X size={13} />
                </button>
              )}
            </div>
            <span className="cfg-rowcount">{allRows ? `${total.toLocaleString()} rows` : '—'}</span>

            <div className="cfg-toolbar-actions">
              <button type="button" className="cfg-tbtn cfg-icononly cfg-undo" onClick={undo} disabled={!history.length} title="Undo">
                <Undo2 size={15} />
              </button>
              <button type="button" className="cfg-tbtn cfg-icononly cfg-undo" onClick={redo} disabled={!future.length} title="Redo">
                <Redo2 size={15} />
              </button>
              <button
                type="button"
                className={`cfg-tbtn${filterOpen ? ' active' : ''}`}
                onClick={() => setFilterOpen((o) => !o)}
                aria-pressed={filterOpen}
              >
                <FilterIcon size={14} /> <span>Filter</span>
              </button>
              <div className="cf-picker" ref={columnsMenuRef}>
                <button type="button" className="cfg-tbtn" onClick={() => setColumnsMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={columnsMenuOpen}>
                  <Columns3 size={14} /> <span>Columns</span>
                </button>
                {columnsMenuOpen && (
                  <div className="cfg-colsmenu" role="menu">
                    {visibleColumns.map((c) => (
                      <label key={c} className="cfg-colsmenu-row">
                        <input type="checkbox" checked={!hiddenCols.has(c)} onChange={() => (hiddenCols.has(c) ? showCol(c) : hideCol(c))} />
                        <span>{c}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="cf-picker">
                <button
                  type="button"
                  className="cfg-tbtn cfg-icononly"
                  title={`Density: ${density}`}
                  onClick={() => setDensity((d) => (d === 'compact' ? 'standard' : d === 'standard' ? 'comfortable' : 'compact'))}
                >
                  <Rows3 size={15} />
                </button>
              </div>
              <button type="button" className="cfg-tbtn" onClick={exportView} disabled={!total}>
                <FileDown size={14} /> <span>Export</span>
              </button>
              <button type="button" className="cfg-tbtn cfg-icononly" onClick={reload} disabled={loading} title="Refresh">
                <RefreshCw size={15} className={loading ? 'cf-spin' : ''} />
              </button>
            </div>
          </div>

          {filterOpen && (
            <div className="cf-filter cfg-filter-row">
              <select className="cf-select" value={filterColumn} onChange={(e) => setFilterColumn(e.target.value)} disabled={!visibleColumns.length}>
                {visibleColumns.length === 0 && <option value="">—</option>}
                {visibleColumns.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className="cf-select cf-op-select" value={filterOp} onChange={(e) => setFilterOp(e.target.value)} disabled={!filterColumn}>
                {FILTER_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <div className="cf-search">
                <Search size={14} className="cf-search-icon" />
                <input
                  className="cf-search-input"
                  placeholder={filterColumn ? OP_PLACEHOLDER[filterOp] : 'no columns'}
                  value={filterInput}
                  onChange={(e) => setFilterInput(e.target.value)}
                  disabled={!filterColumn}
                />
                {filterInput && <button className="cf-search-clear" onClick={() => setFilterInput('')}><X size={13} /></button>}
              </div>
            </div>
          )}

          {checked.size > 0 && (
            <div className="cfg-bulkbar" role="toolbar" aria-label="Checked rows">
              <span>{checked.size.toLocaleString()} row{checked.size === 1 ? '' : 's'} selected</span>
              <div className="cfg-bulkbar-actions">
                <button type="button" className="aa-btn" onClick={copyChecked}><Copy size={14} /> <span>Copy</span></button>
                <button type="button" className="aa-btn" onClick={exportChecked}><FileDown size={14} /> <span>Export CSV</span></button>
                <button type="button" className="aa-btn" onClick={() => setChecked(new Set())}>Clear</button>
              </div>
            </div>
          )}

          <div className="cf-table-wrap cfg-card">
            {error ? (
              <div className="cf-state cf-error">
                <AlertTriangle size={22} />
                <p>{error}</p>
                <button className="cf-retry" onClick={reload}>Retry</button>
              </div>
            ) : !allRows ? (
              <div className="cf-scroll">
                <table className="cf-table cfg-fixed" aria-hidden="true">
                  <thead>
                    <tr>
                      <th className="cfg-gutter-head" />
                      {Array.from({ length: 6 }).map((_, i) => (
                        // eslint-disable-next-line react/no-array-index-key
                        <th key={i}><Skeleton variant="text" width="60%" height={11} /></th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 8 }).map((_, r) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <tr key={r}>
                        <th scope="row" className="cfg-gutter" />
                        {Array.from({ length: 6 }).map((_, i) => (
                          // eslint-disable-next-line react/no-array-index-key
                          <td key={i}><Skeleton variant="text" width={`${50 + ((r * 7 + i * 13) % 40)}%`} height={12} /></td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : !total ? (
              <EmptyState
                type={search || filterValue ? 'no-results' : 'no-data'}
                description={search || filterValue ? 'No record matches that search.' : 'This table has no rows.'}
                actionLabel={search || filterValue ? 'Clear filters' : undefined}
                onAction={search || filterValue ? () => { setSearchInput(''); setFilterInput(''); } : undefined}
              />
            ) : (
              <div className="cf-scroll cfg-scroll" ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} style={{ '--cfg-row-h': `${rowH}px` }}>
                <table
                  ref={gridRef}
                  className="cf-table cfg-fixed"
                  role="grid"
                  aria-label={`${tableLabel(activeTable)} records`}
                  aria-multiselectable="true"
                  aria-rowcount={total + 1}
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
                          checked={visibleRows.length > 0 && visibleRows.every((r) => checked.has(r.ROWID))}
                          onChange={toggleSelectAllOnPage}
                          aria-label="Select all loaded rows"
                        />
                      </th>
                      {displayColumns.map((c, ci) => {
                        const info = sortInfo(c);
                        const pinned = pinnedCols.includes(c);
                        return (
                          <th key={c} scope="col" className={`cfg-th${pinned ? ' cfg-pinned' : ''}`} style={{ width: widthOf(c), ...(pinned ? { left: leftOffsets[c] } : {}) }} aria-sort={info ? (info.dir === 'asc' ? 'ascending' : 'descending') : 'none'} aria-colindex={ci + 2}>
                            <div className="cfg-th-inner">
                              <button
                                type="button"
                                className="cfg-sortbtn"
                                onClick={(e) => cycleSort(c, e.shiftKey)}
                                onKeyDown={(e) => { if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); nudgeWidth(c, e.key === 'ArrowRight' ? 16 : -16); } }}
                                title={`Sort by ${c}${sort.length ? '. Shift-click to add as a secondary sort key' : ''}. Alt+Left/Right resizes.`}
                              >
                                <span>{c}</span>
                                {info ? (info.dir === 'asc' ? <ArrowUp size={11} className="cfg-sort-icon active" /> : <ArrowDown size={11} className="cfg-sort-icon active" />) : <ArrowUpDown size={11} className="cfg-sort-icon" />}
                                {sort.length > 1 && info && <span className="cfg-sort-priority">{info.priority}</span>}
                              </button>
                              <button type="button" className="cfg-menubtn" onClick={(e) => { e.stopPropagation(); setHeaderMenuFor(headerMenuFor === c ? null : c); }} aria-haspopup="menu" aria-expanded={headerMenuFor === c} aria-label={`${c} column options`}>
                                <MoreHorizontal size={13} />
                              </button>
                            </div>
                            {headerMenuFor === c && (
                              <div className="cfg-colmenu" ref={headerMenuRef} role="menu">
                                <button type="button" role="menuitem" onClick={() => { togglePin(c); setHeaderMenuFor(null); }}>
                                  {pinned ? <PinOff size={13} /> : <Pin size={13} />} {pinned ? 'Unpin' : 'Pin to left'}
                                </button>
                                <button type="button" role="menuitem" onClick={() => { hideCol(c); setHeaderMenuFor(null); }}>
                                  <EyeOff size={13} /> Hide column
                                </button>
                              </div>
                            )}
                            <div className="cfg-resize-handle" onMouseDown={(e) => startResize(c, e)} role="separator" aria-orientation="vertical" aria-label={`Resize ${c} column`} tabIndex={-1} />
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {topPad > 0 && (
                      <tr aria-hidden="true" className="cfg-spacer"><td colSpan={displayColumns.length + 1} style={{ height: topPad }} /></tr>
                    )}
                    {visibleRows.map((row, i) => {
                      const r = startIdx + i;
                      return (
                        <tr key={row.ROWID ?? r} aria-rowindex={r + 2} aria-selected={checked.has(row.ROWID)}>
                          <th scope="row" className="cfg-gutter">
                            <span className="cfg-rownum">{r + 1}</span>
                            <input type="checkbox" checked={checked.has(row.ROWID)} onChange={() => toggleOne(row.ROWID)} aria-label={`Select row ${r + 1}`} />
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
                                  ci === 0 ? 'cfg-cell-primary' : '',
                                  numeric ? 'num' : '',
                                  pinned ? 'cfg-pinned' : '',
                                  inRange(r, ci) ? 'in-range' : '',
                                  isActiveCell(r, ci) ? 'active-cell' : '',
                                ].filter(Boolean).join(' ')}
                                style={{ width: widthOf(c), ...(pinned ? { left: leftOffsets[c] } : {}) }}
                                onMouseDown={() => {
                                  gridRef.current?.focus({ preventScroll: true });
                                  setActive({ r, c: ci });
                                  setAnchor({ r, c: ci });
                                  draggingRef.current = true;
                                }}
                                onMouseEnter={() => { if (draggingRef.current) setActive({ r, c: ci }); }}
                              >
                                {fmt(row[c])}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                    {bottomPad > 0 && (
                      <tr aria-hidden="true" className="cfg-spacer"><td colSpan={displayColumns.length + 1} style={{ height: bottomPad }} /></tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="cfg-totals">
                      <th scope="row" className="cfg-gutter" />
                      {displayColumns.map((c, ci) => {
                        const pinned = pinnedCols.includes(c);
                        return (
                          <td
                            key={c}
                            className={`${ci === 0 ? '' : 'num'}${pinned ? ' cfg-pinned' : ''}`}
                            style={{ width: widthOf(c), ...(pinned ? { left: leftOffsets[c] } : {}) }}
                          >
                            {ci === 0
                              ? `${total.toLocaleString()} row${total === 1 ? '' : 's'}`
                              : totals[c] != null ? (<><span className="cfg-totals-label">Sum</span> {compactNum(totals[c])}</>) : null}
                          </td>
                        );
                      })}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          <div className="sr-only" aria-live="polite">{announce}</div>

          <div className="cfg-statusbar">
            <span className="cfg-cellref">{cellRef || '—'}</span>
            <span>{active ? `Count ${selCount.toLocaleString()}` : ''}</span>
          </div>
        </main>
      </div>
    </div>
  );
}
