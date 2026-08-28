import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ChevronDown, ChevronUp, FileDown, Link2, Link2Off, Plus,
  RotateCcw, Save, Search, Sparkles, Trash2, Unlock, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import { useConfirm } from '../components/ConfirmDialog';
import { reportTypeById, extraSheetDefs, initSheetValues } from '../data/reportTemplates';
import { getReport, saveReport, newReportId, downloadReportPdf, aiPolish } from '../utils/reportStudio';
import { listInvestigations } from '../utils/investigation';
import { logAudit } from '../utils/audit';

// The rich-document editor pulls in Tiptap/ProseMirror (~150 kB gzipped), so
// it is code-split: only reports that actually open a document page pay for it.
const DocEditor = lazy(() => import('../components/DocEditor'));
const DocToolbar = lazy(() => import('../components/DocToolbar'));
const RichField = lazy(() => import('../components/RichField'));

// A4 at 96dpi. The on-screen sheet mirrors what SmartBrowz prints server-side.
const PAGE_W = 794;

const pageUid = () => 'pg-' + Math.random().toString(36).slice(2, 10);
const newPageFor = (sheet) => ({ uid: pageUid(), sheetId: sheet.id, values: initSheetValues(sheet) });
const blankPage = () => ({ uid: pageUid(), sheetId: 'blank', doc: null, html: '' });

// Reports drafted in the earlier free-layout canvas stored absolutely
// positioned `elements`. Convert them (top-to-bottom, left-to-right) into
// document content so nothing is lost when they reopen in the rich editor.
function elementsToDoc(elements) {
  const sorted = [...(elements || [])].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const content = sorted.map((el) => {
    const align = el.align && el.align !== 'left' ? { textAlign: el.align } : {};
    const marks = [];
    if (el.bold) marks.push({ type: 'bold' });
    if (el.color && el.color !== '#111111') marks.push({ type: 'textStyle', attrs: { color: el.color } });
    const textNode = (t) => (t ? [{ type: 'text', text: String(t), ...(marks.length ? { marks } : {}) }] : []);

    if (el.type === 'title') {
      return { type: 'heading', attrs: { level: el.level || 2, ...align }, content: textNode(el.text) };
    }
    if (el.type === 'field') {
      const label = el.label ? `${el.label}: ` : '';
      return {
        type: 'paragraph',
        attrs: align,
        content: [
          ...(label ? [{ type: 'text', text: label, marks: [{ type: 'bold' }] }] : []),
          ...(el.text ? [{ type: 'text', text: String(el.text) }] : []),
        ],
      };
    }
    if (el.type === 'bullets') {
      const items = String(el.text || '').split('\n').filter((l) => l.trim());
      if (!items.length) return null;
      return {
        type: 'bulletList',
        content: items.map((l) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: l }] }],
        })),
      };
    }
    if (el.type === 'table') {
      const rows = Array.isArray(el.rows) ? el.rows : [];
      if (!rows.length) return null;
      return {
        type: 'table',
        content: rows.map((r) => ({
          type: 'tableRow',
          content: r.map((c) => ({
            type: 'tableCell',
            content: [{ type: 'paragraph', content: c ? [{ type: 'text', text: String(c) }] : [] }],
          })),
        })),
      };
    }
    // plain text box
    const lines = String(el.text || '').split('\n');
    return lines.map((l) => ({ type: 'paragraph', attrs: align, content: textNode(l) }));
  });
  const flat = content.flat().filter(Boolean);
  return { type: 'doc', content: flat.length ? flat : [{ type: 'paragraph' }] };
}

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

// Narrative values are stored as HTML. These convert between that and the
// plain prose the AI-polish endpoint expects.
function plainText(html) {
  const s = String(html == null ? '' : html);
  if (!/^\s*</.test(s)) return s;
  return s
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((para) => `<p>${para
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br/>')}</p>`)
    .join('');
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
  const confirm = useConfirm();
  // Which rich narrative field has focus, so each sheet's shared toolbar
  // knows what to act on.
  const [activeCtx, setActiveCtx] = useState(null); // { editor, pageUid }
  // First rich field on each page, used as the toolbar's target until the
  // officer focuses a specific one.
  const [pageEditors, setPageEditors] = useState({}); // pageUid -> editor
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
      .then((rec) => {
        if (!live) return;
        // Migrate legacy free-layout pages into rich-document pages.
        const pages = (rec.pages || []).map((p) => (
          p.sheetId === 'blank' && !p.doc && Array.isArray(p.elements)
            ? { uid: p.uid, sheetId: 'blank', doc: elementsToDoc(p.elements), html: '' }
            : p
        ));
        setReport({ ...rec, pages });
      })
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

  // Rich-document page content (Tiptap JSON + rendered HTML for the PDF).
  const setDoc = useCallback((uid, { doc, html }) => {
    mutate((r) => ({
      ...r,
      pages: r.pages.map((p) => (p.uid === uid ? { ...p, doc, html } : p)),
    }));
  }, [mutate]);

  const addPage = () => {
    mutate((r) => ({ ...r, pages: [...r.pages, blankPage()].slice(0, 60) }));
    setTimeout(() => canvasRef.current?.scrollTo({ top: canvasRef.current.scrollHeight, behavior: 'smooth' }), 60);
  };

  const removePage = async (uid) => {
    const ok = await confirm({
      title: 'Remove this page?',
      body: 'Everything entered on it will be deleted. This cannot be undone.',
      confirmLabel: 'Remove page',
      tone: 'danger',
    });
    if (!ok) return;
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
    const prev = page?.values[fieldId] || '';
    // Narrative values are HTML — the model works on plain prose, so strip
    // markup on the way out and rebuild paragraphs on the way back.
    const text = plainText(prev).trim();
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
      setValue(uid, fieldId, textToHtml(polished));
      setAiUndo({ key, prev });
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
          <div className="rb-toolbar-center">
            <span className={`rb-chip ${locked ? 'final' : 'draft'}`}>{locked ? 'Final' : 'Draft'}</span>
            <span className="rb-savestate">
              {saving ? 'Saving…' : dirty ? 'Unsaved edits' : savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}
            </span>
          </div>
          <div className="rb-toolbar-spacer" />
          <div className="rb-zoom">
            <button type="button" className="cf-icon-btn" title="Zoom out" onClick={() => setZoom((z) => Math.max(50, z - 10))}><ZoomOut size={15} /></button>
            <button type="button" className="rb-zoom-pct" title="Fit width" onClick={fitWidth}>{zoom}%</button>
            <button type="button" className="cf-icon-btn" title="Zoom in" onClick={() => setZoom((z) => Math.min(150, z + 10))}><ZoomIn size={15} /></button>
          </div>
          <CaseLink
            report={report}
            locked={locked}
            onLink={(c) => saveNow({ caseMasterId: c ? c.caseMasterId : '', crimeNo: c ? (c.crimeNo || c.caseNo || '') : '' })}
          />
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
                  <div className={`rb-sheet${isBlank ? ' is-doc' : ''}`} style={{ width: PAGE_W }}>
                    {isBlank ? (
                      <Suspense fallback={<div className="rb-doc-loading">Loading editor…</div>}>
                        <DocEditor
                          value={page.doc}
                          html={page.html}
                          locked={locked}
                          onChange={(payload) => setDoc(page.uid, payload)}
                        />
                      </Suspense>
                    ) : (
                      <>
                        {!locked && (sheet.blocks || []).some((b) => b.kind === 'narrative') && (
                          <Suspense fallback={null}>
                            <DocToolbar
                              editor={activeCtx && activeCtx.pageUid === page.uid
                                ? activeCtx.editor
                                : pageEditors[page.uid] || null}
                              pageTools={false}
                            />
                          </Suspense>
                        )}
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
                            onFocusEditor={(ed) => setActiveCtx({ editor: ed, pageUid: page.uid })}
                            onEditorReady={(ed) => setPageEditors((m) => (m[page.uid] ? m : { ...m, [page.uid]: ed }))}
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
                <button type="button" className="rb-addpage-fab" title="Add page" aria-label="Add page" onClick={addPage}>
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

/* ── Case link (ties a report to an Investigation Diary case) ─────────────── */

function CaseLink({ report, locked, onLink }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [cases, setCases] = useState(null);
  const [q, setQ] = useState('');
  const linked = !!report.caseMasterId;

  useEffect(() => {
    if (!open || cases) return;
    listInvestigations().then(setCases).catch(() => setCases([]));
  }, [open, cases]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = cases || [];
    if (!needle) return list.slice(0, 40);
    return list
      .filter((c) => `${c.crimeNo || ''} ${c.caseNo || ''} ${c.station || ''} ${c.district || ''} ${c.sections || ''} ${c.ioName || ''}`
        .toLowerCase().includes(needle))
      .slice(0, 40);
  }, [cases, q]);

  return (
    <div className="rb-caselink">
      {linked ? (
        <span className="rb-caselink-chip">
          <button
            type="button"
            className="rb-caselink-open"
            title="Open the linked case in Investigation Diary"
            onClick={() => navigate(`/investigation-diary/${report.caseMasterId}`)}
          >
            <Link2 size={13} /> {report.crimeNo || 'Linked case'}
          </button>
          {!locked && (
            <button type="button" className="rb-caselink-x" title="Unlink this case" onClick={() => onLink(null)}>
              <X size={12} />
            </button>
          )}
        </span>
      ) : (
        <button
          type="button"
          className="cf-icon-btn"
          title="Link this report to a case"
          disabled={locked}
          onClick={() => setOpen((o) => !o)}
        >
          <Link2Off size={15} />
        </button>
      )}

      {open && !linked && (
        <>
          <div className="rb-caselink-scrim" onClick={() => setOpen(false)} />
          <div className="rb-caselink-menu">
            <div className="rb-caselink-head">
              <Search size={14} />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search cases by crime no., station, sections…"
              />
            </div>
            <div className="rb-caselink-list">
              {!cases && <div className="rb-caselink-empty">Loading cases…</div>}
              {cases && !shown.length && <div className="rb-caselink-empty">No matching cases.</div>}
              {shown.map((c) => (
                <button
                  key={c.caseMasterId}
                  type="button"
                  onClick={() => { onLink(c); setOpen(false); }}
                >
                  <strong>{c.crimeNo || c.caseNo || c.caseMasterId}</strong>
                  <span>{[c.station, c.district, c.sections].filter(Boolean).join(' · ')}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ── Template-sheet blocks (statutory forms keep their prescribed layout) ─── */

function Block({ block: b, bi, page, locked, setValue, setCell, addRow, polish, aiBusy, aiUndo, setAiUndo, onFocusEditor, onEditorReady }) {
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
          <Suspense fallback={<div className="rb-nar-loading">Loading…</div>}>
            <RichField
              value={v[b.id] || ''}
              minLines={Math.min(b.lines || 3, 10)}
              locked={locked}
              onFocusEditor={onFocusEditor}
              onReady={onEditorReady}
              onChange={(html) => {
                setValue(page.uid, b.id, html);
                if (aiUndo && aiUndo.key === key) setAiUndo(null);
              }}
            />
          </Suspense>
          {!locked && (
            <span className="rb-nar-fabs">
              {aiUndo && aiUndo.key === key && (
                <button type="button" className="rb-ai-fab" title="Revert AI edit"
                  onClick={() => { setValue(page.uid, b.id, aiUndo.prev); setAiUndo(null); }}>
                  <RotateCcw size={12} />
                </button>
              )}
              <button type="button" className="rb-ai-fab" disabled={aiBusy === key || !plainText(v[b.id]).trim()}
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
