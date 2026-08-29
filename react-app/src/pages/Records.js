import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Camera, CheckCircle2, FileDown, FileText, Images, Layers,
  Loader2, Search, Trash2, Upload, X, FilePlus2, Files,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import { useConfirm } from '../components/ConfirmDialog';
import {
  listRecords, deleteRecord, uploadScan, newBatchId, recordsToCsv, searchRecords,
  pdfToImages, isPdf,
} from '../utils/digitise';
import { logAudit } from '../utils/audit';

const fmt = (ts) => (ts
  ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');

export default function Records() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [records, setRecords] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [hits, setHits] = useState(null);   // full-text matches inside document text
  const [searching, setSearching] = useState(false);
  const [queue, setQueue] = useState([]); // { key, name, status, error }
  const [dragging, setDragging] = useState(false);
  // Pages staged for the document being assembled. Nothing is filed until the
  // officer says the document is complete — a physical file is usually several
  // photographed pages, and one record per photo was the wrong unit.
  const [tray, setTray] = useState([]);   // [{ key, file, url }]
  const [preparing, setPreparing] = useState(null);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  const refresh = useCallback(() => {
    listRecords().then(setRecords).catch((e) => { setError(e.message); setRecords([]); });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // The index only carries titles and summaries, so a plain client filter can
  // never find a phrase that appears inside a document. Anything longer than a
  // couple of characters is searched server-side across the extracted text.
  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 3) { setHits(null); setSearching(false); return undefined; }
    setSearching(true);
    const t = setTimeout(() => {
      searchRecords(needle, 30)
        .then((h) => setHits(h))
        .catch(() => setHits(null))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const excerptFor = useCallback(
    (id) => (hits || []).find((h) => h.id === id)?.excerpt || '',
    [hits],
  );

  const docTypes = useMemo(() => {
    const set = new Set((records || []).map((r) => r.docType).filter(Boolean));
    return [...set].sort();
  }, [records]);

  const filtered = useMemo(() => {
    if (!records) return [];
    const needle = q.trim().toLowerCase();
    const textMatches = new Set((hits || []).map((h) => h.id));
    return records.filter((r) => {
      if (typeFilter !== 'all' && r.docType !== typeFilter) return false;
      if (!needle) return true;
      if (textMatches.has(r.id)) return true;
      return `${r.title} ${r.docType} ${r.summary} ${r.crimeNo || ''} ${r.filename} ${r.uploadedByName || ''}`
        .toLowerCase().includes(needle);
    });
  }, [records, q, typeFilter, hits]);

  // Files (and PDF pages) are staged, not uploaded — the officer decides what
  // belongs to which document before anything is filed.
  const stage = useCallback(async (files) => {
    const list = [...files];
    const accepted = [];
    let skipped = 0;
    for (const f of list) {
      if (isPdf(f)) {
        try {
          setPreparing(`Reading ${f.name}…`);
          // eslint-disable-next-line no-await-in-loop
          const pages = await pdfToImages(f, (i, n) => setPreparing(`Reading ${f.name} — page ${i} of ${n}…`));
          accepted.push(...pages);
        } catch (e) {
          setError(`Could not read ${f.name} — ${e.message}`);
        } finally {
          setPreparing(null);
        }
      } else if (/^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name)) {
        accepted.push(f);
      } else {
        skipped += 1;
      }
    }
    if (skipped) setError(`${skipped} file${skipped === 1 ? '' : 's'} skipped — only images and PDFs can be scanned.`);
    if (!accepted.length) return;
    setTray((prev) => [
      ...prev,
      ...accepted.map((file, i) => ({
        key: `${Date.now()}-${prev.length + i}-${file.name}`,
        file,
        url: URL.createObjectURL(file),
      })),
    ]);
  }, []);

  const dropPage = (key) => setTray((prev) => {
    const gone = prev.find((p) => p.key === key);
    if (gone) URL.revokeObjectURL(gone.url);
    return prev.filter((p) => p.key !== key);
  });

  const clearTray = useCallback(() => {
    setTray((prev) => { prev.forEach((p) => URL.revokeObjectURL(p.url)); return []; });
  }, []);

  // `asOne` files every staged page into a single document; otherwise each page
  // becomes its own record. Pages upload one at a time — OCR plus the reading
  // pass takes a few seconds each, and the first upload has to return the id
  // the rest append to.
  const saveTray = useCallback(async (asOne) => {
    if (!tray.length) return;
    const batchId = newBatchId();
    const items = tray.map((t) => ({ key: t.key, name: t.file.name, status: 'waiting', file: t.file }));
    setQueue((prev) => [...prev, ...items]);
    clearTray();

    let appendTo = '';
    for (const item of items) {
      setQueue((prev) => prev.map((x) => (x.key === item.key ? { ...x, status: 'working' } : x)));
      try {
        // eslint-disable-next-line no-await-in-loop
        const rec = await uploadScan(item.file, { batchId, appendTo: asOne ? appendTo : '' });
        if (asOne && !appendTo && rec?.id) appendTo = rec.id;
        setQueue((prev) => prev.map((x) => (x.key === item.key ? { ...x, status: 'done' } : x)));
      } catch (e) {
        setQueue((prev) => prev.map((x) => (x.key === item.key ? { ...x, status: 'failed', error: e.message } : x)));
      }
    }
    logAudit('digitise-batch', 'Records', `${items.length} page(s)`);
    refresh();
  }, [tray, clearTray, refresh]);

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer?.files?.length) stage(e.dataTransfer.files);
  };

  const remove = async (r) => {
    const ok = await confirm({
      title: `Delete “${r.title}”?`,
      body: 'The scan and its extracted text are permanently removed.',
      confirmLabel: 'Delete record',
      tone: 'danger',
    });
    if (!ok) return;
    try { await deleteRecord(r.id); refresh(); } catch (e) { setError(e.message); }
  };

  const exportCsv = () => {
    const blob = new Blob([recordsToCsv(filtered)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `digitised-records-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const busy = queue.filter((x) => x.status === 'waiting' || x.status === 'working').length;
  const done = queue.filter((x) => x.status === 'done').length;
  const failed = queue.filter((x) => x.status === 'failed');

  return (
    <div className="cf-page">
      <TopBar title="Records" subtitle="Digitise paper files into searchable records" />
      <div className="pp-body">
        <div className="aa-head">
          <div className="aa-title">
            <Images size={20} strokeWidth={1.9} />
            <div>
              <h1>Records</h1>
              <p>
                Photograph or upload paper documents — the text is read automatically, key particulars
                and tables are pulled out, and everything becomes searchable. The assistant can answer
                questions from these records too.
              </p>
            </div>
          </div>
        </div>

        {/* capture=environment opens the rear camera on a phone */}
        <input
          ref={cameraRef} type="file" accept="image/*" capture="environment" multiple hidden
          onChange={(e) => { if (e.target.files?.length) stage(e.target.files); e.target.value = ''; }}
        />
        <input
          ref={fileRef} type="file" accept="image/*,application/pdf" multiple hidden
          onChange={(e) => { if (e.target.files?.length) stage(e.target.files); e.target.value = ''; }}
        />

        <div
          className={`dg-drop${dragging ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <Layers size={22} strokeWidth={1.7} className="dg-drop-icon" />
          <div className="dg-drop-copy">
            <strong>Drop scans here</strong>
            <span>Images or PDFs · several pages at once is fine · up to 8 MB each</span>
          </div>
          <div className="dg-drop-actions">
            <button type="button" className="aa-btn" onClick={() => cameraRef.current?.click()}>
              <Camera size={15} /> Take photo
            </button>
            <button type="button" className="aa-btn primary" onClick={() => fileRef.current?.click()}>
              <Upload size={15} /> Choose files
            </button>
          </div>
        </div>

        {preparing && <div className="aa-loading">{preparing}</div>}

        {tray.length > 0 && (
          <div className="dg-tray">
            <div className="dg-tray-head">
              <span>
                <Files size={15} /> {tray.length} page{tray.length === 1 ? '' : 's'} ready
              </span>
              <button type="button" className="cf-icon-btn" title="Discard these pages" onClick={clearTray}>
                <X size={14} />
              </button>
            </div>
            <div className="dg-tray-strip">
              {tray.map((pg, i) => (
                <div key={pg.key} className="dg-thumb">
                  <img src={pg.url} alt={pg.file.name} />
                  <span className="dg-thumb-no">{i + 1}</span>
                  <button type="button" className="dg-thumb-x" title="Remove page" onClick={() => dropPage(pg.key)}>
                    <X size={11} />
                  </button>
                </div>
              ))}
              <button type="button" className="dg-thumb dg-thumb-add" onClick={() => fileRef.current?.click()}>
                <FilePlus2 size={18} />
                <span>Add page</span>
              </button>
            </div>
            <div className="dg-tray-actions">
              <button type="button" className="aa-btn primary" onClick={() => saveTray(true)}>
                Save as one document ({tray.length} page{tray.length === 1 ? '' : 's'})
              </button>
              {tray.length > 1 && (
                <button type="button" className="aa-btn" onClick={() => saveTray(false)}>
                  Save as separate documents
                </button>
              )}
            </div>
          </div>
        )}

        {queue.length > 0 && (
          <div className="dg-queue">
            <div className="dg-queue-head">
              <span>
                {busy > 0
                  ? <><Loader2 size={14} className="dg-spin" /> Reading {busy} page{busy === 1 ? '' : 's'}…</>
                  : <><CheckCircle2 size={14} /> {done} page{done === 1 ? '' : 's'} digitised</>}
              </span>
              {busy === 0 && (
                <button type="button" className="cf-icon-btn" title="Clear" onClick={() => setQueue([])}>
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="dg-queue-list">
              {queue.map((x) => (
                <div key={x.key} className={`dg-queue-item ${x.status}`}>
                  <span className="dg-queue-name">{x.name}</span>
                  <span className="dg-queue-status">
                    {x.status === 'waiting' && 'Waiting'}
                    {x.status === 'working' && 'Reading…'}
                    {x.status === 'done' && 'Done'}
                    {x.status === 'failed' && (x.error || 'Failed')}
                  </span>
                </div>
              ))}
            </div>
            {failed.length > 0 && (
              <div className="dg-queue-foot">
                {failed.length} page{failed.length === 1 ? '' : 's'} could not be read — try a sharper, better-lit photo.
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="aa-error">
            <AlertTriangle size={16} /> {error}
            <button type="button" className="cf-icon-btn" onClick={() => setError(null)}><X size={14} /></button>
          </div>
        )}

        <h2 className="rb-section-title">
          Digitised records {records ? <span className="rb-count">({filtered.length})</span> : null}
          {searching && <span className="rb-count"> · searching document text…</span>}
        </h2>
        <div className="aa-toolbar rb-filters">
          <div className="cf-search">
            <Search size={15} className="cf-search-icon" />
            <input
              className="cf-search-input"
              placeholder="Search titles, document text, crime numbers…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select className="aa-select rb-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">All document types</option>
            {docTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button type="button" className="aa-btn" disabled={!filtered.length} onClick={exportCsv}>
            <FileDown size={15} /> Export CSV
          </button>
        </div>

        {!records && <div className="aa-loading">Loading records…</div>}
        {records && !filtered.length && (
          <div className="rb-empty">
            {records.length
              ? 'No record matches that search.'
              : 'Nothing digitised yet — photograph or upload a document above to get started.'}
          </div>
        )}

        <div className="dg-grid">
          {filtered.map((r) => (
            <div
              key={r.id}
              className="dg-card"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/records/${r.id}`)}
              onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/records/${r.id}`); }}
            >
              <div className="dg-card-head">
                <span className="dg-card-type">{r.docType}</span>
                {r.status === 'ocr-failed' && <span className="dg-card-warn">Text not read</span>}
              </div>
              <div className="dg-card-title">{r.title}</div>
              {excerptFor(r.id)
                ? <p className="dg-card-summary dg-card-hit">…{excerptFor(r.id).slice(0, 220).trim()}…</p>
                : r.summary && <p className="dg-card-summary">{r.summary}</p>}
              <div className="dg-card-meta">
                <span><FileText size={11} /> {r.filename}</span>
                {r.pageCount > 1 && <span><Files size={11} /> {r.pageCount} pages</span>}
                {r.tableCount > 0 && <span>{r.tableCount} table{r.tableCount === 1 ? '' : 's'}</span>}
                {r.crimeNo && <span>{r.crimeNo}</span>}
              </div>
              <div className="dg-card-foot">
                <span>{fmt(r.createdAt)}{r.uploadedByName ? ` · ${r.uploadedByName}` : ''}</span>
                <button
                  type="button"
                  className="cf-icon-btn danger"
                  title="Delete"
                  onClick={(e) => { e.stopPropagation(); remove(r); }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
