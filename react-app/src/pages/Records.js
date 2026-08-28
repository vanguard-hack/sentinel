import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Camera, CheckCircle2, FileDown, FileText, Images, Layers,
  Loader2, Search, Trash2, Upload, X,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import { useConfirm } from '../components/ConfirmDialog';
import {
  listRecords, deleteRecord, uploadScan, newBatchId, recordsToCsv,
} from '../utils/digitise';
import { logAudit } from '../utils/audit';

const fmt = (ts) => (ts
  ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');

// Uploads run a few at a time: OCR plus an LLM pass takes a few seconds per
// page, and firing fifty at once would stall the function and the browser.
const CONCURRENCY = 3;

export default function Records() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [records, setRecords] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [queue, setQueue] = useState([]); // { key, name, status, error }
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  const refresh = useCallback(() => {
    listRecords().then(setRecords).catch((e) => { setError(e.message); setRecords([]); });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const docTypes = useMemo(() => {
    const set = new Set((records || []).map((r) => r.docType).filter(Boolean));
    return [...set].sort();
  }, [records]);

  const filtered = useMemo(() => {
    if (!records) return [];
    const needle = q.trim().toLowerCase();
    return records.filter((r) => {
      if (typeFilter !== 'all' && r.docType !== typeFilter) return false;
      if (!needle) return true;
      return `${r.title} ${r.docType} ${r.summary} ${r.crimeNo || ''} ${r.filename} ${r.uploadedByName || ''}`
        .toLowerCase().includes(needle);
    });
  }, [records, q, typeFilter]);

  // Bulk ingest: a shared batch id ties the pages of one physical file
  // together, and a small worker pool keeps the queue moving.
  const ingest = useCallback(async (files) => {
    const images = [...files].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
    const skipped = [...files].length - images.length;
    if (skipped > 0) {
      setError(`${skipped} file${skipped === 1 ? '' : 's'} skipped — only images can be scanned. For a PDF, export its pages as images first.`);
    }
    if (!images.length) return;

    const batchId = newBatchId();
    const items = images.map((file, i) => ({ key: `${batchId}-${i}`, name: file.name, status: 'waiting', file }));
    setQueue((prev) => [...prev, ...items]);

    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor;
        cursor += 1;
        if (i >= items.length) return;
        const item = items[i];
        setQueue((prev) => prev.map((x) => (x.key === item.key ? { ...x, status: 'working' } : x)));
        try {
          await uploadScan(item.file, { batchId });
          setQueue((prev) => prev.map((x) => (x.key === item.key ? { ...x, status: 'done' } : x)));
        } catch (e) {
          setQueue((prev) => prev.map((x) => (x.key === item.key ? { ...x, status: 'failed', error: e.message } : x)));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    logAudit('digitise-batch', 'Records', `${items.length} page(s)`);
    refresh();
  }, [refresh]);

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer?.files?.length) ingest(e.dataTransfer.files);
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
          <div className="aa-toolbar">
            <button type="button" className="aa-btn" onClick={() => cameraRef.current?.click()}>
              <Camera size={15} /> Take photo
            </button>
            <button type="button" className="aa-btn primary" onClick={() => fileRef.current?.click()}>
              <Upload size={15} /> Upload files
            </button>
          </div>
        </div>

        {/* capture=environment opens the rear camera on a phone */}
        <input
          ref={cameraRef} type="file" accept="image/*" capture="environment" multiple hidden
          onChange={(e) => { if (e.target.files?.length) ingest(e.target.files); e.target.value = ''; }}
        />
        <input
          ref={fileRef} type="file" accept="image/*" multiple hidden
          onChange={(e) => { if (e.target.files?.length) ingest(e.target.files); e.target.value = ''; }}
        />

        <div
          className={`dg-drop${dragging ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') fileRef.current?.click(); }}
        >
          <Layers size={22} strokeWidth={1.7} />
          <div>
            <strong>Drop scans here, or click to choose files</strong>
            <span>Several pages at once is fine — JPG, PNG, WebP or HEIC, up to 8 MB each</span>
          </div>
        </div>

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
              {r.summary && <p className="dg-card-summary">{r.summary}</p>}
              <div className="dg-card-meta">
                <span><FileText size={11} /> {r.filename}</span>
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
