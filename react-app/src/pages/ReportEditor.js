import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, AlignCenter, AlignLeft, AlignRight, Bold, ChevronDown,
  ChevronUp, FileDown, Heading1, List, Move, Plus, RectangleHorizontal,
  RotateCcw, Save, Sparkles, Table as TableIcon, Trash2, Type, Unlock, ZoomIn, ZoomOut,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import { reportTypeById, extraSheetDefs, initSheetValues } from '../data/reportTemplates';
import { getReport, saveReport, newReportId, downloadReportPdf, aiPolish } from '../utils/reportStudio';
import { logAudit } from '../utils/audit';

// A4 at 96dpi. The on-screen sheet mirrors what SmartBrowz prints server-side.
const PAGE_W = 794;
// Usable free-layout canvas inside a blank page (fits the printed A4 content box).
export const FREE_W = 682;
export const FREE_H = 1005;

const pageUid = () => 'pg-' + Math.random().toString(36).slice(2, 10);
const elUid = () => 'el-' + Math.random().toString(36).slice(2, 10);

const newPageFor = (sheet) => ({ uid: pageUid(), sheetId: sheet.id, values: initSheetValues(sheet) });
const blankPage = () => ({ uid: pageUid(), sheetId: 'blank', values: {}, elements: [] });

// Default geometry & typography for each free-layout element type.
const EL_DEFAULTS = {
  title: { w: 420, h: 36, text: 'Section title', fontSize: 16, bold: true, align: 'center', color: '#111111' },
  field: { w: 300, h: 48, label: 'Field name', text: '', fontSize: 12, bold: false, align: 'left', color: '#111111' },
  text: { w: 420, h: 110, text: '', fontSize: 12, bold: false, align: 'left', color: '#111111' },
  bullets: { w: 380, h: 100, text: 'First point\nSecond point', fontSize: 12, bold: false, align: 'left', color: '#111111' },
  table: { w: 520, h: 120, fontSize: 11, bold: false, align: 'left', color: '#111111', rows: [['', '', ''], ['', '', ''], ['', '', '']] },
};

function freshReport(type) {
  return {
    id: newReportId(),
    typeId: type.id,
    title: `${type.name} — ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`,
    status: 'draft',
    refNo: '',
    pages: type.sheets.map(newPageFor),
  };
}

// Auto-growing textarea for narrative blocks.
function AutoTextarea({ value, minLines, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, (minLines || 3) * 19 + 12)}px`;
  }, [value, minLines]);
  return <textarea ref={ref} rows={minLines || 3} value={value} {...rest} />;
}

export default function ReportEditor() {
  const { reportId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [exporting, setExporting] = useState(false);
  const [aiBusy, setAiBusy] = useState(null); // "uid:fieldId" of narrative being polished
  const [aiUndo, setAiUndo] = useState(null); // { key, prev }
  const [selected, setSelected] = useState(null); // { pageUid, elId } on blank pages
  const canvasRef = useRef(null);
  const reportRef = useRef(null);
  reportRef.current = report;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const type = report ? reportTypeById(report.typeId) : null;
  const locked = report?.status === 'final';

  // Load or create.
  useEffect(() => {
    let live = true;
    if (reportId === 'new') {
      const t = reportTypeById(searchParams.get('type'));
      if (!t) { setError('Unknown report type'); return undefined; }
      const rec = freshReport(t);
      setReport(rec);
      // Claim a real URL immediately so refresh/back behave, and persist the shell.
      saveReport(rec)
        .then(() => { if (live) { setSavedAt(Date.now()); navigate(`/report-studio/${rec.id}`, { replace: true }); } })
        .catch((e) => live && setError(e.message));
      logAudit('create-report', 'Report Studio', t.name);
      return () => { live = false; };
    }
    getReport(reportId)
      .then((rec) => live && setReport(rec))
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [reportId, searchParams, navigate]);

  // Debounced autosave whenever the document changes.
  useEffect(() => {
    if (!dirty || !report) return undefined;
    const t = setTimeout(async () => {
      try {
        setSaving(true);
        await saveReport(reportRef.current);
        setSavedAt(Date.now());
        setDirty(false);
      } catch (e) {
        setError(`Autosave failed — ${e.message}`);
      } finally {
        setSaving(false);
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [dirty, report]);

  // Warn before leaving with unsaved edits still in the debounce window.
  useEffect(() => {
    const onUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  const mutate = useCallback((fn) => {
    setReport(fn);
    setDirty(true);
  }, []);

  const setValue = useCallback((uid, key, v) => {
    mutate((r) => ({
      ...r,
      pages: r.pages.map((p) => (p.uid === uid ? { ...p, values: { ...p.values, [key]: v } } : p)),
    }));
  }, [mutate]);

  const setCell = useCallback((uid, tableId, ri, ci, v) => {
    mutate((r) => ({
      ...r,
      pages: r.pages.map((p) => {
        if (p.uid !== uid) return p;
        const rows = (p.values[tableId] || []).map((row, i) => (i === ri ? row.map((c, j) => (j === ci ? v : c)) : row));
        return { ...p, values: { ...p.values, [tableId]: rows } };
      }),
    }));
  }, [mutate]);

  const addRow = (uid, block) => {
    mutate((r) => ({
      ...r,
      pages: r.pages.map((p) => {
        if (p.uid !== uid) return p;
        const rows = [...(p.values[block.id] || []), block.columns.map(() => '')];
        return { ...p, values: { ...p.values, [block.id]: rows.slice(0, 40) } };
      }),
    }));
  };

  // ── free-layout (blank page) element ops ──────────────────────────────────
  const updateEl = useCallback((uid, elId, fn) => {
    mutate((r) => ({
      ...r,
      pages: r.pages.map((p) => (p.uid !== uid ? p : {
        ...p,
        elements: (p.elements || []).map((el) => (el.id === elId ? fn(el) : el)),
      })),
    }));
  }, [mutate]);

  const addEl = (uid, elType, opts) => {
    mutate((r) => ({
      ...r,
      pages: r.pages.map((p) => {
        if (p.uid !== uid) return p;
        const n = (p.elements || []).length;
        const el = {
          id: elUid(), type: elType,
          x: 40 + ((n * 16) % 120), y: 48 + ((n * 24) % 240),
          ...JSON.parse(JSON.stringify(EL_DEFAULTS[elType])),
        };
        if (elType === 'table' && opts) {
          const c = Math.max(1, Math.min(10, opts.cols || 3));
          const rws = Math.max(1, Math.min(20, opts.rows || 3));
          const cw = Math.max(40, Math.min(110, Math.floor(620 / c)));
          el.rows = Array.from({ length: rws }, () => Array(c).fill(''));
          el.colW = Array(c).fill(cw);
          el.rowH = Array(rws).fill(28);
          el.w = cw * c;
          el.h = 28 * rws;
        }
        setSelected({ pageUid: uid, elId: el.id });
        return { ...p, elements: [...(p.elements || []), el].slice(0, 120) };
      }),
    }));
  };

  const removeEl = (uid, elId) => {
    mutate((r) => ({
      ...r,
      pages: r.pages.map((p) => (p.uid !== uid ? p : { ...p, elements: (p.elements || []).filter((e) => e.id !== elId) })),
    }));
    setSelected(null);
  };

  const addPage = (sheet) => {
    mutate((r) => ({ ...r, pages: [...r.pages, sheet ? newPageFor(sheet) : blankPage()].slice(0, 60) }));
    setTimeout(() => canvasRef.current?.scrollTo({ top: canvasRef.current.scrollHeight, behavior: 'smooth' }), 60);
  };

  const removePage = (uid) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Remove this page and everything entered on it?')) return;
    mutate((r) => ({ ...r, pages: r.pages.filter((p) => p.uid !== uid) }));
  };

  const movePage = (uid, dir) => {
    mutate((r) => {
      const i = r.pages.findIndex((p) => p.uid === uid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= r.pages.length) return r;
      const pages = [...r.pages];
      [pages[i], pages[j]] = [pages[j], pages[i]];
      return { ...r, pages };
    });
  };

  const saveNow = async (patch) => {
    try {
      setSaving(true);
      const rec = { ...reportRef.current, ...(patch || {}) };
      if (patch) setReport(rec);
      await saveReport(rec);
      setSavedAt(Date.now());
      setDirty(false);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const exportPdf = async () => {
    try {
      setExporting(true);
      if (dirty) await saveNow();
      await downloadReportPdf(reportRef.current);
      logAudit('download-report', 'Report Studio', reportRef.current.title);
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  };

  const polish = async (uid, fieldId, label) => {
    const page = reportRef.current.pages.find((p) => p.uid === uid);
    const text = (page?.values[fieldId] || '').trim();
    if (!text) return;
    const key = `${uid}:${fieldId}`;
    setAiBusy(key);
    try {
      let polished;
      try {
        polished = await aiPolish({ text, label, reportName: type?.name });
      } catch {
        // One transparent retry — the backend also falls back across models,
        // so a second invocation almost always lands.
        await new Promise((s) => setTimeout(s, 1500));
        polished = await aiPolish({ text, label, reportName: type?.name });
      }
      setValue(uid, fieldId, polished);
      setAiUndo({ key, prev: text });
      setError(null);
    } catch (e) {
      setError(`AI assist failed — ${e.message}`);
    } finally {
      setAiBusy(null);
    }
  };

  const fitWidth = () => {
    const w = canvasRef.current?.clientWidth || PAGE_W;
    setZoom(Math.max(50, Math.min(150, Math.floor(((w - 48) / PAGE_W) * 100))));
  };

  const extras = useMemo(() => (type ? extraSheetDefs(type) : []), [type]);

  if (error && !report) {
    return (
      <div className="cf-page">
        <TopBar title="Report Studio" parent="Report Studio" parentTo="/report-studio" />
        <div className="pp-body"><div className="aa-error"><AlertTriangle size={16} /> {error}</div></div>
      </div>
    );
  }
  if (!report || !type) {
    return (
      <div className="cf-page">
        <TopBar title="Report Studio" parent="Report Studio" parentTo="/report-studio" />
        <div className="pp-body"><div className="aa-loading">Opening report…</div></div>
      </div>
    );
  }

  return (
    <div className="cf-page">
      <TopBar title={type.name} parent="Report Studio" parentTo="/report-studio" />
      <div className="rb-editor">
        <div className="rb-toolbar">
          <input
            className="rb-title-input"
            value={report.title}
            disabled={locked}
            maxLength={160}
            onChange={(e) => mutate((r) => ({ ...r, title: e.target.value }))}
            aria-label="Report title"
          />
          <span className={`rb-chip ${locked ? 'final' : 'draft'}`}>{locked ? 'Final' : 'Draft'}</span>
          <span className="rb-savestate">
            {saving ? 'Saving…' : dirty ? 'Unsaved edits' : savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
          <div className="rb-toolbar-spacer" />
          <div className="rb-zoom">
            <button type="button" className="cf-icon-btn" title="Zoom out" onClick={() => setZoom((z) => Math.max(50, z - 10))}><ZoomOut size={15} /></button>
            <button type="button" className="rb-zoom-pct" title="Fit width" onClick={fitWidth}>{zoom}%</button>
            <button type="button" className="cf-icon-btn" title="Zoom in" onClick={() => setZoom((z) => Math.min(150, z + 10))}><ZoomIn size={15} /></button>
          </div>
          {locked && (
            <button type="button" className="cf-icon-btn" title="Reopen for editing" onClick={() => saveNow({ status: 'draft' })}>
              <Unlock size={15} />
            </button>
          )}
          <button type="button" className="cf-icon-btn" title="Save now" onClick={() => saveNow()} disabled={saving || locked}>
            <Save size={15} />
          </button>
          <button type="button" className="cf-icon-btn primary" title="Download PDF" onClick={exportPdf} disabled={exporting}>
            <FileDown size={15} />
          </button>
        </div>

        {error && <div className="aa-error rb-editor-error"><AlertTriangle size={16} /> {error}</div>}

        <div className="rb-canvas" ref={canvasRef}>
          <div className="rb-zoom-stage" style={{ zoom: zoom / 100 }}>
            {report.pages.map((page, pi) => {
              const isBlank = page.sheetId === 'blank';
              const sheet = isBlank ? null : (
                type.sheets.find((s) => s.id === page.sheetId)
                || extras.map((e) => e.sheet).find((s) => s.id === page.sheetId)
                || { title: 'Sheet', blocks: [] }
              );
              return (
                <div className="rb-sheet-wrap" key={page.uid}>
                  {!locked && (
                    <div className="rb-page-tools">
                      <button type="button" className="cf-icon-btn" title="Move up" disabled={pi === 0} onClick={() => movePage(page.uid, -1)}><ChevronUp size={14} /></button>
                      <button type="button" className="cf-icon-btn" title="Move down" disabled={pi === report.pages.length - 1} onClick={() => movePage(page.uid, 1)}><ChevronDown size={14} /></button>
                      <button type="button" className="cf-icon-btn danger" title="Remove page" disabled={report.pages.length === 1} onClick={() => removePage(page.uid)}><Trash2 size={14} /></button>
                    </div>
                  )}
                  <div className="rb-sheet" style={{ width: PAGE_W }}>
                    {isBlank ? (
                      <FreeSheet
                        page={page}
                        locked={locked}
                        zoomRef={zoomRef}
                        selected={selected && selected.pageUid === page.uid ? selected.elId : null}
                        onSelect={(elId) => setSelected(elId ? { pageUid: page.uid, elId } : null)}
                        updateEl={updateEl}
                        addEl={addEl}
                        removeEl={removeEl}
                      />
                    ) : (
                      <>
                        <div className="rb-sheet-hdr">
                          <div className="rb-sheet-org">KARNATAKA STATE POLICE</div>
                          <h2>{sheet.title}</h2>
                          {sheet.subtitle && <div className="rb-sheet-sub">{sheet.subtitle}</div>}
                        </div>
                        {(sheet.blocks || []).map((b, bi) => (
                          <Block
                            key={bi}
                            block={b}
                            bi={bi}
                            page={page}
                            locked={locked}
                            setValue={setValue}
                            setCell={setCell}
                            addRow={addRow}
                            polish={polish}
                            aiBusy={aiBusy}
                            aiUndo={aiUndo}
                            setAiUndo={setAiUndo}
                          />
                        ))}
                      </>
                    )}
                    <div className="rb-sheet-pgno">Page {pi + 1} of {report.pages.length}</div>
                  </div>
                </div>
              );
            })}

            {!locked && (
              <div className="rb-addpage-wrap" style={{ width: PAGE_W }}>
                <button
                  type="button"
                  className="rb-addpage-fab"
                  title="Add blank page"
                  aria-label="Add blank page"
                  onClick={() => addPage(null)}
                >
                  <Plus size={20} strokeWidth={2.2} />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Template-sheet blocks ─────────────────────────────────────────────────── */

function Block({ block: b, bi, page, locked, setValue, setCell, addRow, polish, aiBusy, aiUndo, setAiUndo }) {
  const v = page.values || {};
  if (b.kind === 'fields') {
    return (
      <div>
        {b.legend && <div className="rb-legend">{b.legend}</div>}
        <div className="rb-grid">
          {b.fields.map((f) => (
            <label key={f.id} className="rb-field" style={{ gridColumn: `span ${f.span || 12}` }}>
              <span className="rb-lbl">{f.label}</span>
              {f.type === 'select' ? (
                <select value={v[f.id] || ''} disabled={locked} onChange={(e) => setValue(page.uid, f.id, e.target.value)}>
                  <option value="">—</option>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  type={f.type === 'date' ? 'date' : f.type === 'time' ? 'time' : 'text'}
                  value={v[f.id] || ''}
                  disabled={locked}
                  onChange={(e) => setValue(page.uid, f.id, e.target.value)}
                />
              )}
              {f.hint && <span className="rb-hint">{f.hint}</span>}
            </label>
          ))}
        </div>
      </div>
    );
  }
  if (b.kind === 'table') {
    const rows = Array.isArray(v[b.id]) ? v[b.id] : [];
    return (
      <div>
        {b.label && <div className="rb-legend">{b.label}</div>}
        <div className="rb-table-scroll">
          <table className="rb-table">
            <thead>
              <tr>{b.columns.map((c) => <th key={c.id} style={c.width ? { width: `${c.width}%` } : undefined}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {b.columns.map((c, ci) => (
                    <td key={c.id}>
                      <input value={row[ci] || ''} disabled={locked} onChange={(e) => setCell(page.uid, b.id, ri, ci, e.target.value)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {b.footnote && <div className="rb-hint">{b.footnote}</div>}
        {!locked && (
          <button type="button" className="rb-addrow" onClick={() => addRow(page.uid, b)}>
            <Plus size={12} /> Add row
          </button>
        )}
      </div>
    );
  }
  if (b.kind === 'narrative') {
    const key = `${page.uid}:${b.id}`;
    return (
      <div className="rb-narrative">
        <div className="rb-legend">{b.label}</div>
        <div className="rb-nar-box">
          <AutoTextarea
            value={v[b.id] || ''}
            minLines={Math.min(b.lines || 3, 10)}
            disabled={locked}
            onChange={(e) => { setValue(page.uid, b.id, e.target.value); if (aiUndo && aiUndo.key === key) setAiUndo(null); }}
          />
          {!locked && (
            <span className="rb-nar-fabs">
              {aiUndo && aiUndo.key === key && (
                <button type="button" className="rb-ai-fab" title="Revert AI edit"
                  onClick={() => { setValue(page.uid, b.id, aiUndo.prev); setAiUndo(null); }}>
                  <RotateCcw size={12} />
                </button>
              )}
              <button type="button" className="rb-ai-fab" disabled={aiBusy === key || !(v[b.id] || '').trim()}
                title="AI polish — rewrite in formal report language (facts preserved)"
                onClick={() => polish(page.uid, b.id, b.label)}>
                <Sparkles size={12} className={aiBusy === key ? 'rb-spin' : undefined} />
              </button>
            </span>
          )}
        </div>
        {b.hint && <span className="rb-hint">{b.hint}</span>}
      </div>
    );
  }
  if (b.kind === 'note') return <p className="rb-note">{b.text}</p>;
  if (b.kind === 'signatures') {
    return (
      <div className="rb-sigs">
        {b.blocks.map((sb, j) => (
          <div key={j} className="rb-sig">
            <div className="rb-sig-space" />
            <div className="rb-sig-label">{sb.label}</div>
            {(sb.fields || []).map((f) => (
              <label key={f} className="rb-sig-field">
                <span>{f}:</span>
                <input value={v[`b${bi}:${j}:${f}`] || ''} disabled={locked} onChange={(e) => setValue(page.uid, `b${bi}:${j}:${f}`, e.target.value)} />
              </label>
            ))}
          </div>
        ))}
      </div>
    );
  }
  return null;
}

/* ── Free-layout (blank page) designer ─────────────────────────────────────── */

const SNAP = 6;

// Snap a proposed x/y against page edges, page centre and sibling edges/centres.
// Returns the snapped position plus the guide lines to draw.
function snapAxis(pos, size, limit, cands) {
  for (const [target, line] of cands) {
    if (Math.abs(pos - target) <= SNAP) return { pos: target, line };
  }
  return { pos: Math.max(0, Math.min(limit - size, pos)), line: null };
}

function FreeSheet({ page, locked, zoomRef, selected, onSelect, updateEl, addEl, removeEl }) {
  const [guides, setGuides] = useState({ v: null, h: null });
  const [picker, setPicker] = useState(false);
  const dragRef = useRef(null);
  const elsRef = useRef([]);
  elsRef.current = page.elements || [];

  const endDrag = useCallback(() => {
    dragRef.current = null;
    setGuides({ v: null, h: null });
  }, []);

  useEffect(() => () => endDrag(), [endDrag]);

  const onMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    const k = (zoomRef.current || 100) / 100;
    const dx = (e.clientX - d.sx) / k;
    const dy = (e.clientY - d.sy) / k;
    const el = elsRef.current.find((x) => x.id === d.id);
    if (!el) return;
    if (d.mode === 'resize') {
      const w = Math.max(60, Math.min(FREE_W - el.x, d.ow + dx));
      const h = Math.max(26, Math.min(FREE_H - el.y, d.oh + dy));
      if (el.type === 'table' && d.g0) {
        // Whole-table resize: scale every column width and row height
        // proportionally to the dragged outer box.
        const w0 = d.g0.colW.reduce((a, b) => a + b, 0);
        const h0 = d.g0.rowH.reduce((a, b) => a + b, 0);
        const colW = d.g0.colW.map((cw) => Math.max(32, Math.round((cw * w) / w0)));
        const rowH = d.g0.rowH.map((rh) => Math.max(22, Math.round((rh * h) / h0)));
        updateEl(page.uid, d.id, (x) => syncTableSize({ ...x, colW, rowH }));
        return;
      }
      updateEl(page.uid, d.id, (x) => ({ ...x, w: Math.round(w), h: Math.round(h) }));
      return;
    }
    const others = elsRef.current.filter((x) => x.id !== d.id);
    const xCands = [[0, 0], [(FREE_W - el.w) / 2, FREE_W / 2], [FREE_W - el.w, FREE_W]];
    const yCands = [[0, 0], [(FREE_H - el.h) / 2, FREE_H / 2], [FREE_H - el.h, FREE_H]];
    others.forEach((o) => {
      xCands.push([o.x, o.x], [o.x + o.w - el.w, o.x + o.w], [o.x + (o.w - el.w) / 2, o.x + o.w / 2]);
      yCands.push([o.y, o.y], [o.y + o.h - el.h, o.y + o.h], [o.y + (o.h - el.h) / 2, o.y + o.h / 2]);
    });
    const sx = snapAxis(d.ox + dx, el.w, FREE_W, xCands);
    const sy = snapAxis(d.oy + dy, el.h, FREE_H, yCands);
    setGuides({ v: sx.line, h: sy.line });
    updateEl(page.uid, d.id, (x) => ({ ...x, x: Math.round(sx.pos), y: Math.round(sy.pos) }));
  }, [page.uid, updateEl, zoomRef]);

  const startDrag = (e, el, mode) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(el.id);
    dragRef.current = {
      mode, id: el.id, sx: e.clientX, sy: e.clientY, ox: el.x, oy: el.y, ow: el.w, oh: el.h,
      g0: el.type === 'table' ? tableGeom(el) : null,
    };
    const up = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', up);
      endDrag();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', up);
  };

  const selectedEl = (page.elements || []).find((e) => e.id === selected) || null;

  return (
    <div className="rb-free" onPointerDown={() => onSelect(null)}>
      {!locked && (
        <div className="rb-palette" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" title="Add heading" onClick={() => addEl(page.uid, 'title')}><Heading1 size={14} /> Heading</button>
          <button type="button" title="Add labelled field" onClick={() => addEl(page.uid, 'field')}><RectangleHorizontal size={14} /> Field</button>
          <button type="button" title="Add text box" onClick={() => addEl(page.uid, 'text')}><Type size={14} /> Text</button>
          <button type="button" title="Add bullet list" onClick={() => addEl(page.uid, 'bullets')}><List size={14} /> Bullets</button>
          <div className="rb-table-pick-wrap">
            <button type="button" title="Insert table — pick dimensions" onClick={() => setPicker((o) => !o)}>
              <TableIcon size={14} /> Table
            </button>
            {picker && (
              <TableDimPicker
                onPick={(rows, cols) => { setPicker(false); addEl(page.uid, 'table', { rows, cols }); }}
              />
            )}
          </div>
        </div>
      )}

      {!locked && selectedEl && (
        <div className="rb-props" onPointerDown={(e) => e.stopPropagation()}>
          <label title="Font size">
            <input
              type="number" min={8} max={40} value={selectedEl.fontSize}
              onChange={(e) => updateEl(page.uid, selectedEl.id, (x) => ({ ...x, fontSize: Math.max(8, Math.min(40, Number(e.target.value) || 12)) }))}
            />
            px
          </label>
          <input
            type="color" title="Text colour" value={selectedEl.color || '#111111'}
            onChange={(e) => updateEl(page.uid, selectedEl.id, (x) => ({ ...x, color: e.target.value }))}
          />
          <button type="button" className={selectedEl.bold ? 'on' : ''} title="Bold"
            onClick={() => updateEl(page.uid, selectedEl.id, (x) => ({ ...x, bold: !x.bold }))}><Bold size={13} /></button>
          <button type="button" className={selectedEl.align === 'left' ? 'on' : ''} title="Align left"
            onClick={() => updateEl(page.uid, selectedEl.id, (x) => ({ ...x, align: 'left' }))}><AlignLeft size={13} /></button>
          <button type="button" className={selectedEl.align === 'center' ? 'on' : ''} title="Align centre"
            onClick={() => updateEl(page.uid, selectedEl.id, (x) => ({ ...x, align: 'center' }))}><AlignCenter size={13} /></button>
          <button type="button" className={selectedEl.align === 'right' ? 'on' : ''} title="Align right"
            onClick={() => updateEl(page.uid, selectedEl.id, (x) => ({ ...x, align: 'right' }))}><AlignRight size={13} /></button>
          {selectedEl.type === 'table' && (
            <>
              <button type="button" title="Remove last row" onClick={() => updateEl(page.uid, selectedEl.id, (x) => {
                if (x.rows.length <= 1) return x;
                const g = tableGeom(x);
                return syncTableSize({ ...x, rows: x.rows.slice(0, -1), colW: g.colW, rowH: g.rowH.slice(0, -1) });
              })}>−Row</button>
              <button type="button" title="Remove last column" onClick={() => updateEl(page.uid, selectedEl.id, (x) => {
                if ((x.rows[0] || []).length <= 1) return x;
                const g = tableGeom(x);
                return syncTableSize({ ...x, rows: x.rows.map((r) => r.slice(0, -1)), colW: g.colW.slice(0, -1), rowH: g.rowH });
              })}>−Col</button>
            </>
          )}
          <button type="button" className="danger" title="Delete element" onClick={() => removeEl(page.uid, selectedEl.id)}><Trash2 size={13} /></button>
        </div>
      )}

      <div className="rb-free-canvas" style={{ width: FREE_W, height: FREE_H }}>
        {(page.elements || []).length === 0 && (
          <div className="rb-free-empty">Blank page — add headings, fields, text boxes, bullet lists or tables from the palette above, then drag them anywhere. Edges snap to guides for alignment.</div>
        )}
        {guides.v != null && <div className="rb-guide-v" style={{ left: guides.v }} />}
        {guides.h != null && <div className="rb-guide-h" style={{ top: guides.h }} />}
        {(page.elements || []).map((el) => (
          <FreeElement
            key={el.id}
            el={el}
            locked={locked}
            selected={selected === el.id}
            startDrag={startDrag}
            zoomRef={zoomRef}
            update={(fn) => updateEl(page.uid, el.id, fn)}
          />
        ))}
      </div>
    </div>
  );
}

function FreeElement({ el, locked, selected, startDrag, zoomRef, update }) {
  const style = {
    left: el.x, top: el.y, width: el.w,
    height: el.type === 'table' ? 'auto' : el.h,
    fontSize: el.fontSize, color: el.color || '#111',
    fontWeight: el.bold ? 700 : 400, textAlign: el.align || 'left',
  };
  const stop = (e) => e.stopPropagation();

  let body = null;
  if (el.type === 'title') {
    body = (
      <input
        className="rb-el-input" value={el.text} disabled={locked} placeholder="Heading…"
        style={{ textAlign: el.align }} onChange={(e) => update((x) => ({ ...x, text: e.target.value }))}
      />
    );
  } else if (el.type === 'field') {
    body = (
      <div className="rb-el-fieldwrap">
        <input
          className="rb-el-label" value={el.label || ''} disabled={locked} placeholder="FIELD NAME"
          onChange={(e) => update((x) => ({ ...x, label: e.target.value }))}
        />
        <input
          className="rb-el-input dotted" value={el.text || ''} disabled={locked} placeholder="…"
          style={{ textAlign: el.align }} onChange={(e) => update((x) => ({ ...x, text: e.target.value }))}
        />
      </div>
    );
  } else if (el.type === 'text') {
    body = (
      <textarea
        className="rb-el-area" value={el.text || ''} disabled={locked} placeholder="Text…"
        style={{ textAlign: el.align }} onChange={(e) => update((x) => ({ ...x, text: e.target.value }))}
      />
    );
  } else if (el.type === 'bullets') {
    body = (
      <div className="rb-el-bulletwrap">
        <div className="rb-el-bulletdots" style={{ fontSize: el.fontSize }} aria-hidden="true">
          {String(el.text || '').split('\n').map((l, i) => <div key={i}>{l.trim() ? '•' : ' '}</div>)}
        </div>
        <textarea
          className="rb-el-area" value={el.text || ''} disabled={locked} placeholder={'One point per line'}
          onChange={(e) => update((x) => ({ ...x, text: e.target.value }))}
        />
      </div>
    );
  } else if (el.type === 'table') {
    body = <TableElement el={el} locked={locked} selected={selected} update={update} zoomRef={zoomRef} />;
  }

  return (
    <div
      className={`rb-el${selected ? ' sel' : ''}${el.type === 'table' ? ' is-table' : ''}`}
      style={style}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!selected) startDrag(e, el, 'move');
      }}
    >
      {selected && !locked && (
        <>
          <div className="rb-el-grip" title="Drag to move" onPointerDown={(e) => startDrag(e, el, 'move')}>
            <Move size={11} />
          </div>
          <div className="rb-el-resize" title="Drag to resize" onPointerDown={(e) => startDrag(e, el, 'resize')} />
        </>
      )}
      <div className="rb-el-body" onPointerDown={selected ? stop : undefined}>{body}</div>
    </div>
  );
}

/* ── Google-Docs-style table: dimension picker, hover inserts, resizable
      columns & rows ─────────────────────────────────────────────────────── */

// Normalised column widths / row heights for a table element (older tables
// saved before geometry existed get sensible defaults).
export function tableGeom(el) {
  const cols = (el.rows && el.rows[0] ? el.rows[0].length : 1) || 1;
  const colW = Array.isArray(el.colW) && el.colW.length === cols
    ? el.colW
    : Array(cols).fill(Math.max(40, Math.round((el.w || 520) / cols)));
  const rowH = Array.isArray(el.rowH) && el.rowH.length === (el.rows || []).length
    ? el.rowH
    : (el.rows || []).map(() => 28);
  return { colW, rowH };
}

// Keep the element's outer box in sync with its grid so dragging/snapping
// and PDF layout stay truthful.
function syncTableSize(el) {
  const { colW, rowH } = tableGeom(el);
  return { ...el, colW, rowH, w: colW.reduce((a, b) => a + b, 0), h: rowH.reduce((a, b) => a + b, 0) };
}

function TableDimPicker({ onPick }) {
  const [dims, setDims] = useState({ r: 3, c: 3 });
  const COLS = 10;
  const ROWS = 8;
  return (
    <div className="rb-dim-picker" onPointerDown={(e) => e.stopPropagation()}>
      <div className="rb-dim-grid" style={{ gridTemplateColumns: `repeat(${COLS}, 16px)` }}>
        {Array.from({ length: ROWS * COLS }, (_, i) => {
          const r = Math.floor(i / COLS) + 1;
          const c = (i % COLS) + 1;
          const on = r <= dims.r && c <= dims.c;
          return (
            <button
              key={i}
              type="button"
              className={`rb-dim-cell${on ? ' on' : ''}`}
              onPointerEnter={() => setDims({ r, c })}
              onClick={() => onPick(r, c)}
              aria-label={`${c} × ${r} table`}
            />
          );
        })}
      </div>
      <div className="rb-dim-label">{dims.c} × {dims.r}</div>
    </div>
  );
}

function TableElement({ el, locked, selected, update, zoomRef }) {
  const { colW, rowH } = tableGeom(el);
  const dragRef = useRef(null);
  const [hover, setHover] = useState(null); // pointer position in table-local px

  // Column / row border resize (Google-Docs style drag on the grid lines).
  const startResize = (e, axis, idx) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    const orig = axis === 'col' ? colW[idx] : rowH[idx];
    dragRef.current = { axis, idx, start: axis === 'col' ? e.clientX : e.clientY, orig };
    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      const k = (zoomRef?.current || 100) / 100;
      const delta = ((d.axis === 'col' ? ev.clientX : ev.clientY) - d.start) / k;
      update((x) => {
        const g = tableGeom(x);
        if (d.axis === 'col') {
          const next = [...g.colW];
          next[d.idx] = Math.round(Math.max(32, Math.min(660, d.orig + delta)));
          return syncTableSize({ ...x, colW: next, rowH: g.rowH });
        }
        const next = [...g.rowH];
        next[d.idx] = Math.round(Math.max(22, Math.min(400, d.orig + delta)));
        return syncTableSize({ ...x, colW: g.colW, rowH: next });
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const insertCol = (at) => update((x) => {
    const g = tableGeom(x);
    if (g.colW.length >= 12) return x;
    const w = 80;
    return syncTableSize({
      ...x,
      rows: x.rows.map((r) => [...r.slice(0, at), '', ...r.slice(at)]),
      colW: [...g.colW.slice(0, at), w, ...g.colW.slice(at)],
      rowH: g.rowH,
    });
  });

  const insertRow = (at) => update((x) => {
    const g = tableGeom(x);
    if (g.rowH.length >= 30) return x;
    return syncTableSize({
      ...x,
      rows: [...x.rows.slice(0, at), x.rows[0].map(() => ''), ...x.rows.slice(at)],
      colW: g.colW,
      rowH: [...g.rowH.slice(0, at), 28, ...g.rowH.slice(at)],
    });
  });

  const totalW = colW.reduce((a, b) => a + b, 0);
  // Boundary offsets for the hover "+" chips and resize strips.
  const xAt = colW.reduce((acc, w) => [...acc, acc[acc.length - 1] + w], [0]);
  const yAt = rowH.reduce((acc, h) => [...acc, acc[acc.length - 1] + h], [0]);

  // Show a single insert chip only at the boundary the pointer is near —
  // like Google Docs' hover affordance.
  const NEAR = 16;
  let colChip = null;
  let rowChip = null;
  if (hover && selected && !locked) {
    let best = NEAR + 1;
    xAt.forEach((x, i) => {
      const d = Math.abs(hover.x - x);
      if (d < best) { best = d; colChip = { x, i }; }
    });
    best = NEAR + 1;
    yAt.forEach((y, i) => {
      const d = Math.abs(hover.y - y);
      if (d < best) { best = d; rowChip = { y, i }; }
    });
  }

  const onHoverMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const k = (zoomRef?.current || 100) / 100;
    setHover({ x: (e.clientX - rect.left) / k, y: (e.clientY - rect.top) / k });
  };

  return (
    <div
      className="rb-tablewrap"
      style={{ width: totalW }}
      onPointerMove={selected && !locked ? onHoverMove : undefined}
      onPointerLeave={() => setHover(null)}
    >
      <table className="rb-el-table" style={{ width: totalW, tableLayout: 'fixed' }}>
        <colgroup>{colW.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
        <tbody>
          {(el.rows || []).map((row, ri) => (
            <tr key={ri} style={{ height: rowH[ri] }}>
              {row.map((cell, ci) => (
                <td key={ci}>
                  <textarea
                    value={cell} disabled={locked} rows={1}
                    onChange={(e) => update((x) => ({
                      ...x,
                      rows: x.rows.map((r, i) => (i === ri ? r.map((c, j) => (j === ci ? e.target.value : c)) : r)),
                    }))}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {selected && !locked && (
        <>
          {/* drag the inner grid lines (and outer right/bottom edge) to resize */}
          {xAt.slice(1).map((x, i) => (
            <div key={`c${i}`} className="rb-tresize-v" style={{ left: x - 3 }}
              title="Drag to resize column" onPointerDown={(e) => startResize(e, 'col', i)} />
          ))}
          {yAt.slice(1).map((y, i) => (
            <div key={`r${i}`} className="rb-tresize-h" style={{ top: y - 3 }}
              title="Drag to resize row" onPointerDown={(e) => startResize(e, 'row', i)} />
          ))}
          {/* single hover "+" chip at the boundary the pointer is near */}
          {colChip && (
            <button type="button" className="rb-tinsert rb-tinsert-col" style={{ left: colChip.x - 9 }}
              title={colChip.i === 0 ? 'Insert column left' : colChip.i === colW.length ? 'Insert column right' : 'Insert column here'}
              onPointerDown={(e) => e.stopPropagation()} onClick={() => insertCol(colChip.i)}>
              <Plus size={11} />
            </button>
          )}
          {rowChip && (
            <button type="button" className="rb-tinsert rb-tinsert-row" style={{ top: rowChip.y - 9 }}
              title={rowChip.i === 0 ? 'Insert row above' : rowChip.i === rowH.length ? 'Insert row below' : 'Insert row here'}
              onPointerDown={(e) => e.stopPropagation()} onClick={() => insertRow(rowChip.i)}>
              <Plus size={11} />
            </button>
          )}
        </>
      )}
    </div>
  );
}
