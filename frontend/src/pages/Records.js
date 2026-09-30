import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Camera, CheckCircle2, FileDown, FileText, Images, Layers,
  Loader2, Search, Trash2, X, FilePlus2, Files, CheckSquare, Square,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import FileUpload from '../components/ui/FileUpload';
import { useConfirm } from '../components/ConfirmDialog';
import { AnimatedToastStack, useAnimatedToastStack } from '../components/ui/AnimatedToastStack';
import EmptyState from '../components/ui/EmptyState';
import Skeleton from '../components/ui/Skeleton';
import {
  listRecords, deleteRecord, uploadScan, newBatchId, recordsToCsv, searchRecords,
  pdfToImages, isPdf, ingestExtracted, attachSource,
} from '../utils/digitise';
import { extractText, detectKind, isPageKind, KIND_LABEL, filesFromClipboard } from '../utils/extract';
import { transcribeAudio } from '../utils/assistant';
import { logAudit } from '../utils/audit';
import { useTranslation } from 'react-i18next';

const fmt = (ts) => (ts
  ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');

const ACCEPT_LIST = '.jpg,.jpeg,.png,.webp,.heic,.heif,.gif,.bmp,.tif,.tiff,.pdf,.docx,.docm,.xlsx,.xlsm,.xls,.csv,.tsv,.ods,.pptx,.pptm,.txt,.md,.log,.json,.xml,.rtf,.eml,.vtt,.srt,.mp3,.wav,.m4a,.aac,.ogg,.opus,.flac,.amr,.mp4,.mov,.m4v,.webm,.3gp,image/*,application/pdf,audio/*,video/*,text/*';

export default function Records() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [records, setRecords] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [hits, setHits] = useState(null);   // full-text matches inside document text
  const [searching, setSearching] = useState(false);
  const [queue, setQueue] = useState([]); // { key, name, status, error }
  // Pages staged for the document being assembled. Nothing is filed until the
  // officer says the document is complete — a physical file is usually several
  // photographed pages, and one record per photo was the wrong unit.
  const [tray, setTray] = useState([]);   // [{ key, file, url }]
  const [preparing, setPreparing] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const { toasts, showToast, updateToast, dismissToast } = useAnimatedToastStack();
  const selToastId = useRef(null);
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

  // Read and file everything that carries its own text. Each file becomes one
  // record; the queue reports them alongside scanned pages so the officer sees
  // one list, not two.
  const fileReadable = useCallback(async (files) => {
    const batchId = newBatchId();
    setQueue((prev) => [
      ...prev,
      ...files.map((f) => ({ key: `${batchId}-${f.name}`, name: f.name, status: 'waiting' })),
    ]);
    for (const f of files) {
      const key = `${batchId}-${f.name}`;
      const mark = (patch) => setQueue((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)));
      mark({ status: 'working' });
      try {
        // eslint-disable-next-line no-await-in-loop
        const { text, tables, kind, note } = await extractText(f, {
          // The officer's language, same as the OCR path above. Left off, this
          // defaulted to English, so a Kannada statement recording filed into
          // Records came back as plausible Latin nonsense — the identical
          // failure the OCR language fix addressed, one call site over.
          transcribe: (blob, name) => transcribeAudio(
            new File([blob], name || 'audio.wav', { type: 'audio/wav' }),
            i18n.resolvedLanguage || 'en',
          ),
          onProgress: (m) => mark({ detail: m }),
        });
        // eslint-disable-next-line no-await-in-loop
        const filed = await ingestExtracted({
          filename: f.name,
          mime: f.type || 'application/octet-stream',
          text, tables, note, sourceKind: kind, batchId,
        });
        // Keep the original next to the text it produced, so a recording can
        // be played back and a document downloaded as filed. The text is
        // already filed, so a failure here does not lose the record — but it
        // is REPORTED rather than swallowed: silently dropping the source of a
        // transcript is exactly the kind of gap nobody notices until the
        // recording is needed and it is not there.
        let sourceWarning = '';
        try {
          // eslint-disable-next-line no-await-in-loop
          await attachSource(filed.id, f);
        } catch (e) {
          sourceWarning = `filed, but the original was not kept — ${e.message}`;
        }
        mark({ status: sourceWarning ? 'partial' : 'done', detail: '', error: sourceWarning });
        logAudit('records-ingest', 'Records', `${f.name} (${kind})`);
      } catch (e) {
        mark({ status: 'failed', error: e.message, detail: '' });
      }
    }
    refresh();
  }, [refresh, i18n.resolvedLanguage]);

  // Files (and PDF pages) are staged, not uploaded — the officer decides what
  // belongs to which document before anything is filed.
  const stage = useCallback(async (files) => {
    const list = [...files];
    const accepted = [];
    const problems = [];
    // Files that already contain their text never enter the page tray — a
    // spreadsheet or a recording is not a page of anything, so it is read and
    // filed on the spot rather than waiting to be assembled into a document.
    const readable = [];
    for (const f of list) {
      const kind = detectKind(f);
      if (isPdf(f)) {
        try {
          setPreparing(`Reading ${f.name}…`);
          // eslint-disable-next-line no-await-in-loop
          const pages = await pdfToImages(f, (i, n) => setPreparing(`Reading ${f.name} — page ${i} of ${n}…`));
          accepted.push(...pages);
        } catch (e) {
          problems.push(`${f.name} — ${e.message}`);
        } finally {
          setPreparing(null);
        }
      } else if (isPageKind(kind)) {
        accepted.push(f);
      } else if (kind === 'unsupported' || kind === 'legacy') {
        // Named explicitly: "skipped" without a reason leaves the officer
        // guessing whether the file was too big, wrong, or simply lost.
        problems.push(kind === 'legacy'
          ? `${f.name} is in the old Office format — re-save it as .docx, .xlsx or .pptx`
          : `${f.name} is not a file type Records can read`);
      } else {
        readable.push(f);
      }
    }
    if (readable.length) fileReadable(readable);
    if (problems.length) setError(problems.join(' · '));
    if (!accepted.length) return;
    setTray((prev) => [
      ...prev,
      ...accepted.map((file, i) => ({
        key: `${Date.now()}-${prev.length + i}-${file.name}`,
        file,
        url: URL.createObjectURL(file),
      })),
    ]);
  }, [fileReadable]);

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
        const rec = await uploadScan(item.file, {
          batchId, appendTo: asOne ? appendTo : '',
          // The officer's own interface language is the best guess at what the
          // paper says; Zia reads a Kannada page very differently when told so.
          lang: i18n.resolvedLanguage,
        });
        if (asOne && !appendTo && rec?.id) appendTo = rec.id;
        setQueue((prev) => prev.map((x) => (x.key === item.key ? { ...x, status: 'done' } : x)));
      } catch (e) {
        setQueue((prev) => prev.map((x) => (x.key === item.key ? { ...x, status: 'failed', error: e.message } : x)));
      }
    }
    logAudit('digitise-batch', 'Records', `${items.length} page(s)`);
    refresh();
  }, [tray, clearTray, refresh, i18n.resolvedLanguage]);

  // Paste a file straight onto the page — copy it in Finder or Explorer, or
  // take a screenshot, then Ctrl/Cmd+V anywhere on Records.
  //
  // Two clipboard shapes have to be handled. A file copied from the desktop
  // arrives in `files` with its real name. A screenshot or an image copied
  // from another app arrives as an `item` with no name at all — those get a
  // timestamped one, because a station's records filling up with a dozen
  // documents all called "image.png" helps nobody.
  useEffect(() => {
    const onPaste = (e) => {
      const picked = filesFromClipboard(e.clipboardData);
      // Nothing pasted but text — leave it alone so the search box still works.
      if (!picked.length) return;
      e.preventDefault();
      stage(picked);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [stage]);

  const remove = async (r) => {
    const ok = await confirm({
      title: t('records.deleteTitle', { title: r.title }),
      body: t('records.deleteBody'),
      confirmLabel: t('records.deleteConfirm'),
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await deleteRecord(r.id);
      setSelected((prev) => { const next = new Set(prev); next.delete(r.id); return next; });
      refresh();
    } catch (e) { setError(e.message); }
  };

  const toggleSelect = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const allVisibleSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const toggleSelectAll = () => setSelected((prev) => {
    if (allVisibleSelected) {
      const next = new Set(prev);
      filtered.forEach((r) => next.delete(r.id));
      return next;
    }
    const next = new Set(prev);
    filtered.forEach((r) => next.add(r.id));
    return next;
  });

  // Every record is deleted the same way a single one is — the same blob and
  // index entry the assistant's own search reads live, so a record dropped
  // here stops being searchable (including by the assistant) the instant the
  // call returns. There is no separate knowledge base to clean up afterwards.
  const bulkRemove = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    const ok = await confirm({
      title: t('records.deleteSelectedTitle', { count: ids.length }),
      body: t('records.deleteSelectedBody'),
      confirmLabel: t('records.deleteSelectedConfirm'),
      tone: 'danger',
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => deleteRecord(id)));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) setError(`${failed} of ${ids.length} record${ids.length === 1 ? '' : 's'} could not be deleted.`);
      setSelected(new Set());
      refresh();
    } finally {
      setBulkBusy(false);
    }
  };
  const bulkRemoveRef = useRef(bulkRemove);
  bulkRemoveRef.current = bulkRemove;

  const handleDismissToast = (id) => {
    if (id === selToastId.current) {
      selToastId.current = null;
      setSelected(new Set());
    }
    dismissToast(id);
  };

  // Selection is announced as a small floating toast instead of a full-width
  // banner pushed into the page flow — same count/clear/delete controls, just
  // not shaped like a modal. The toast's own × doubles as "clear selection".
  useEffect(() => {
    if (selected.size === 0) {
      if (selToastId.current) { dismissToast(selToastId.current); selToastId.current = null; }
      return;
    }
    const payload = bulkBusy
      ? { status: 'loading', title: t('records.selectedCount', { count: selected.size }), dismissible: false, duration: 0 }
      : {
          status: 'info',
          title: t('records.selectedCount', { count: selected.size }),
          dismissible: true,
          duration: 0,
          action: { label: t('records.deleteSelected'), onClick: () => bulkRemoveRef.current() },
        };
    if (selToastId.current) updateToast(selToastId.current, payload);
    else selToastId.current = showToast(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.size, bulkBusy]);

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
  const done = queue.filter((x) => x.status === 'done' || x.status === 'partial').length;
  const failed = queue.filter((x) => x.status === 'failed');

  return (
    <div className="cf-page">
      <TopBar title={t('records.title')} subtitle={t('records.subtitle')} />
      <div className="pp-body">
        <div className="aa-head">
          <div className="aa-title">
            <Images size={20} strokeWidth={1.9} />
            <div>
              <h1>{t('records.title')}</h1>
              <p>
{t('records.intro')}
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
          ref={fileRef} type="file" multiple hidden
          accept={ACCEPT_LIST}
          onChange={(e) => { if (e.target.files?.length) stage(e.target.files); e.target.value = ''; }}
        />

        <FileUpload onFiles={stage} accept={ACCEPT_LIST} busy={!!preparing} className="dg-drop" label={t('records.chooseFiles')}>
          <Layers size={22} strokeWidth={1.7} className="dg-drop-icon" />
          <div className="dg-drop-copy">
            <strong>{t('records.dropTitle')}</strong>
            <span>{t('records.dropHint')}</span>
          </div>
          <div className="dg-drop-actions">
            {/* Sits inside the clickable panel, so it stops the click bubbling
                — otherwise taking a photo would also open the file picker
                behind it. */}
            <button
              type="button"
              className="aa-btn"
              onClick={(e) => { e.stopPropagation(); cameraRef.current?.click(); }}
            >
              <Camera size={15} /> {t('records.takePhoto')}
            </button>
          </div>
        </FileUpload>

        {preparing && <div className="aa-loading">{preparing}</div>}

        {tray.length > 0 && (
          <div className="dg-tray">
            <div className="dg-tray-head">
              <span>
                <Files size={15} /> {tray.length} page{tray.length === 1 ? '' : 's'} ready
              </span>
              <button type="button" className="cf-icon-btn" title={t('records.discardPages')} onClick={clearTray}>
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
                <span>{t('records.addPage')}</span>
              </button>
            </div>
            <div className="dg-tray-actions">
              <button type="button" className="aa-btn primary" onClick={() => saveTray(true)}>
{t('records.saveOne')} ({t('records.pagesReady', { count: tray.length })})
              </button>
              {tray.length > 1 && (
                <button type="button" className="aa-btn" onClick={() => saveTray(false)}>
{t('records.saveSeparate')}
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
                  ? <><Loader2 size={14} className="dg-spin" /> Reading {busy} file{busy === 1 ? '' : 's'}…</>
                  : <><CheckCircle2 size={14} /> {done} file{done === 1 ? '' : 's'} digitised</>}
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
                    {x.status === 'working' && (x.detail || 'Reading…')}
                    {x.status === 'done' && 'Done'}
                    {x.status === 'partial' && (x.error || 'Filed without the original')}
                    {x.status === 'failed' && (x.error || 'Failed')}
                  </span>
                </div>
              ))}
            </div>
            {failed.length > 0 && (
              <div className="dg-queue-foot">
                {failed.length} file{failed.length === 1 ? '' : 's'} could not be read. For a photographed page, try a sharper, better-lit shot.
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
          {t('records.digitised')} {records ? <span className="rb-count">({filtered.length})</span> : null}
          {searching && <span className="rb-count"> · searching document text…</span>}
        </h2>
        <div className="aa-toolbar rb-filters">
          <div className="cf-search">
            <Search size={15} className="cf-search-icon" />
            <input
              className="cf-search-input"
              placeholder={t('records.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select className="aa-select rb-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">{t('records.allDocTypes')}</option>
            {docTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button type="button" className="aa-btn" disabled={!filtered.length} onClick={exportCsv}>
            <FileDown size={15} /> {t('records.exportCsv')}
          </button>
          <button
            type="button"
            className="aa-btn"
            disabled={!filtered.length}
            onClick={toggleSelectAll}
            aria-pressed={allVisibleSelected}
          >
            {allVisibleSelected ? <CheckSquare size={15} /> : <Square size={15} />} {t('records.selectAll')}
          </button>
        </div>

        {!records && (
          <div className="dg-grid">
            {[0, 1, 2].map((i) => (
              <div className="dg-card" key={i}>
                <div className="dg-card-head">
                  <Skeleton variant="rect" width={54} height={18} />
                </div>
                <Skeleton variant="text" width="70%" height={15} />
                <Skeleton variant="text" height={12} />
                <Skeleton variant="text" width="85%" height={12} />
                <Skeleton variant="text" width={120} height={11} />
              </div>
            ))}
          </div>
        )}
        {records && !filtered.length && (
          <EmptyState
            type={records.length ? 'no-results' : 'no-data'}
            description={records.length ? t('records.noMatch') : t('records.empty')}
          />
        )}

        <div className="dg-grid">
          {filtered.map((r) => (
            <div
              key={r.id}
              className={`dg-card${selected.has(r.id) ? ' selected' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/records/${r.id}`)}
              onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/records/${r.id}`); }}
            >
              <div className="dg-card-head">
                <span className="dg-card-head-left">
                  <button
                    type="button"
                    className="dg-card-check"
                    aria-pressed={selected.has(r.id)}
                    aria-label={selected.has(r.id) ? 'Deselect record' : 'Select record'}
                    onClick={(e) => { e.stopPropagation(); toggleSelect(r.id); }}
                  >
                    {selected.has(r.id) ? <CheckSquare size={16} /> : <Square size={16} />}
                  </button>
                  <span className="dg-card-type">{r.docType}</span>
                </span>
                {r.status === 'ocr-failed' && <span className="dg-card-warn">{t('records.textNotRead')}</span>}
              </div>
              <div className="dg-card-title">{r.title}</div>
              {excerptFor(r.id)
                ? <p className="dg-card-summary dg-card-hit">…{excerptFor(r.id).slice(0, 220).trim()}…</p>
                : r.summary && <p className="dg-card-summary">{r.summary}</p>}
              <div className="dg-card-meta">
                <span><FileText size={11} /> {r.filename}</span>
                {r.sourceKind && r.sourceKind !== 'scan' && KIND_LABEL[r.sourceKind] && (
                  <span>{KIND_LABEL[r.sourceKind]}</span>
                )}
                {r.pageCount > 1 && <span><Files size={11} /> {r.pageCount} pages</span>}
                {r.tableCount > 0 && <span>{r.tableCount} table{r.tableCount === 1 ? '' : 's'}</span>}
                {r.crimeNo && <span>{r.crimeNo}</span>}
              </div>
              <div className="dg-card-foot">
                <span>{fmt(r.createdAt)}{r.uploadedByName ? ` · ${r.uploadedByName}` : ''}</span>
                <button
                  type="button"
                  className="cf-icon-btn danger"
                  title={t('common.delete')}
                  onClick={(e) => { e.stopPropagation(); remove(r); }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <AnimatedToastStack toasts={toasts} onDismiss={handleDismissToast} position="bottom-center" fixed />
    </div>
  );
}
