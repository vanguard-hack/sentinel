import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertTriangle, Check, Copy, FileDown, FileText, Pencil, RotateCcw,
  Save, Table as TableIcon,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import { getRecord, updateRecord, fetchScanUrl, fetchFileUrl } from '../utils/digitise';
import { provenanceOf, isMedia, isPaper, sizeOf } from '../utils/provenance';

export default function RecordDetail() {
  const { recordId } = useParams();
  const [rec, setRec] = useState(null);
  const [imgUrls, setImgUrls] = useState([]);
  const [media, setMedia] = useState(null);   // { url, mime } for a recording
  const [loadingSource, setLoadingSource] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const origText = useRef('');

  useEffect(() => {
    let live = true;
    getRecord(recordId)
      .then(async (r) => {
        if (!live) return;
        setRec(r);
        setDraft(r.text || '');
        origText.current = r.text || '';
        // Only scanned paper has page images. A recording or a document has
        // one stored original, fetched with its real type so it can play.
        if (!isPaper(r.sourceKind)) {
          if (r.key) {
            try {
              const m = await fetchFileUrl(r.key);
              if (live) setMedia(m);
            } catch { /* the text stands on its own without the original */ }
          }
          if (live) setLoadingSource(false);
          return;
        }
        // A document can be several photographed pages; older records carry a
        // single `key` instead of a pages array.
        const keys = ((r.pages || []).length ? r.pages.map((pg) => pg.key) : [r.key]).filter(Boolean);
        const urls = [];
        for (const k of keys) {
          try {
            // eslint-disable-next-line no-await-in-loop
            urls.push(await fetchScanUrl(k));
          } catch { /* a missing page shouldn't hide the rest */ }
          if (!live) return;
          setImgUrls([...urls]);
        }
        if (live) setLoadingSource(false);
      })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [recordId]);

  // An object URL outlives the component unless it is released.
  useEffect(() => () => { if (media?.url) URL.revokeObjectURL(media.url); }, [media]);

  const patch = useCallback(async (fields) => {
    setSaving(true);
    try {
      const next = await updateRecord({ id: recordId, ...fields });
      setRec(next);
      setError(null);
      return next;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setSaving(false);
    }
  }, [recordId]);

  const saveText = async () => {
    const next = await patch({ text: draft });
    if (next) { origText.current = next.text || ''; setEditing(false); }
  };

  const copyText = () => {
    try {
      navigator.clipboard.writeText(rec?.text || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — the text is selectable on screen */ }
  };

  const downloadText = () => {
    const blob = new Blob([rec?.text || ''], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(rec?.title || 'record').replace(/[^\w\d-]+/g, '-').slice(0, 60)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  if (error && !rec) {
    return (
      <div className="cf-page">
        <TopBar title="Record" parent="Records" parentTo="/records" />
        <div className="pp-body"><div className="aa-error"><AlertTriangle size={16} /> {error}</div></div>
      </div>
    );
  }
  if (!rec) {
    return (
      <div className="cf-page">
        <TopBar title="Record" parent="Records" parentTo="/records" />
        <div className="pp-body"><div className="aa-loading">Opening record…</div></div>
      </div>
    );
  }

  return (
    <div className="cf-page">
      <TopBar title={rec.title} parent="Records" parentTo="/records" />
      <div className="pp-body">
        {error && <div className="aa-error"><AlertTriangle size={16} /> {error}</div>}

        <div className="dg-detail-head">
          <input
            className="dg-title-input"
            value={rec.title}
            maxLength={160}
            onChange={(e) => setRec((r) => ({ ...r, title: e.target.value }))}
            onBlur={(e) => patch({ title: e.target.value })}
            aria-label="Record title"
          />
          {saving && <span className="rb-savestate">Saving…</span>}
        </div>

        <div className="dg-detail">
          <div className="dg-scan">
            {isPaper(rec.sourceKind) && (
              imgUrls.length
                ? imgUrls.map((u, i) => (
                    <figure key={i} className="dg-scan-page">
                      <img src={u} alt={`${rec.filename} — page ${i + 1}`} />
                      {imgUrls.length > 1 && <figcaption>Page {i + 1} of {(rec.pages || []).length || imgUrls.length}</figcaption>}
                    </figure>
                  ))
                : <div className="aa-loading">{loadingSource ? 'Loading scan…' : 'The original scan is no longer stored.'}</div>
            )}

            {isMedia(rec.sourceKind) && (
              media
                ? (
                  <div className="dg-player">
                    {rec.sourceKind === 'video'
                      ? <video className="dg-video" src={media.url} controls preload="metadata" />
                      : <audio className="dg-audio" src={media.url} controls preload="metadata" />}
                    <p className="dg-player-note">
                      Play alongside the transcript to check anything the recognition may have misheard.
                    </p>
                  </div>
                )
                : (
                  <div className="dg-nosource">
                    <FileText size={20} strokeWidth={1.7} />
                    <strong>{loadingSource ? 'Loading recording…' : 'Recording not stored'}</strong>
                    {!loadingSource && (
                      <span>The transcript below is the complete record. The original file was too large to keep, or was filed before recordings were retained.</span>
                    )}
                  </div>
                )
            )}

            {!isPaper(rec.sourceKind) && !isMedia(rec.sourceKind) && (
              <div className="dg-nosource">
                <FileText size={20} strokeWidth={1.7} />
                <strong>{provenanceOf(rec).label}</strong>
                <span>{rec.filename}</span>
                {media && (
                  <a className="aa-btn" href={media.url} download={rec.filename}>
                    <FileDown size={15} /> Download original
                  </a>
                )}
              </div>
            )}

            <div className="dg-scan-meta">
              {(rec.pages || []).length > 1
                ? `${rec.pages.length} pages`
                : rec.filename}
              {sizeOf(rec, media) ? ` · ${sizeOf(rec, media)}` : ''}
              {rec.uploadedByName ? ` · ${rec.uploadedByName}` : ''}
            </div>
          </div>

          <div className="dg-extract">
            {rec.summary && <p className="dg-summary">{rec.summary}</p>}

            {!!Object.keys(rec.fields || {}).length && (
              <>
                <h3 className="dg-h3">Key particulars</h3>
                <div className="dg-fields">
                  {Object.entries(rec.fields).map(([k, v]) => (
                    <div key={k} className="dg-field">
                      <span className="dg-field-k">{k}</span>
                      <span className="dg-field-v">{v}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {(rec.tables || []).map((t, i) => (
              <div key={i} className="dg-table-wrap">
                <h3 className="dg-h3"><TableIcon size={13} /> {t.title || `Table ${i + 1}`}</h3>
                <div className="rb-table-scroll">
                  <table className="dg-table">
                    {!!(t.columns || []).length && (
                      <thead><tr>{t.columns.map((c, ci) => <th key={ci}>{c}</th>)}</tr></thead>
                    )}
                    <tbody>
                      {(t.rows || []).map((row, ri) => (
                        <tr key={ri}>{row.map((c, ci) => <td key={ci}>{c}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            <div className="dg-text-head">
              <h3 className="dg-h3">{isMedia(rec.sourceKind) ? 'Transcript' : 'Extracted text'}</h3>
              <div className="dg-text-actions">
                <button type="button" className="cf-icon-btn" title={copied ? 'Copied' : 'Copy text'} onClick={copyText}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <button type="button" className="cf-icon-btn" title="Download as .txt" onClick={downloadText}>
                  <FileDown size={14} />
                </button>
                {editing ? (
                  <>
                    <button type="button" className="cf-icon-btn" title="Discard changes"
                      onClick={() => { setDraft(origText.current); setEditing(false); }}>
                      <RotateCcw size={14} />
                    </button>
                    <button type="button" className="cf-icon-btn primary" title="Save corrections" onClick={saveText}>
                      <Save size={14} />
                    </button>
                  </>
                ) : (
                  <button type="button" className="cf-icon-btn" title="Correct the text" onClick={() => setEditing(true)}>
                    <Pencil size={14} />
                  </button>
                )}
              </div>
            </div>

            {rec.status === 'ocr-failed' && isPaper(rec.sourceKind) && (
              <div className="aa-error">
                <AlertTriangle size={15} /> The text could not be read from this scan
                {rec.error ? ` (${rec.error})` : ''}. You can type it in by hand.
              </div>
            )}

            {editing
              ? <textarea className="dg-text-edit" value={draft} onChange={(e) => setDraft(e.target.value)} />
              : <pre className="dg-text">{rec.text || provenanceOf(rec).empty}</pre>}
            <p className="dg-note">{provenanceOf(rec).note}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
