import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  NotebookPen, AlertTriangle, Plus, Sparkles, ListChecks, Users, Fingerprint,
  MessageSquareQuote, Clock, Link2, ChevronDown, ChevronLeft, ChevronRight,
  Mic, Upload, Paperclip, Play, FileText, Pencil, Trash2, FileDown,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import {
  getInvestigation, setInvestigationStatus, appendInvestigationItem, summarizeInvestigation,
  updateInvestigationItem, deleteInvestigationItem,
  statusColor, IIF_LABELS,
  STATUS_OPTIONS, PERSON_ROLES, PERSON_STATUSES, EVIDENCE_TYPES, FSL_STATUSES, TIMELINE_TYPES, FINDING_TYPES,
  uploadEvidenceMedia, fetchEvidenceMediaUrl, ocrExtractText,
} from '../utils/investigation';
import { transcribeAudio } from '../utils/assistant';
import { exportInvestigationDiaryPdf } from '../utils/reportPdf';
import i18n from '../i18n';

const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtDateTime = (ts) => (ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

// A collapsible "add entry" form. `fields` describe simple inputs; the parent
// owns submission (so the section-specific append call + optimistic refresh
// stays in the tab component).
function AddEntryForm({ label, fields, onSubmit, submitLabel = 'Add entry' }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key, v) => setValues((s) => ({ ...s, [key]: v }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
      setValues({});
      setOpen(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="inv-add-btn" onClick={() => setOpen(true)}>
        <Plus size={15} /> {label}
      </button>
    );
  }

  return (
    <div className="inv-add-form">
      {fields.map((f) => (
        <label key={f.key} className={`inv-field ${f.wide ? 'wide' : ''}`}>
          {f.label}
          {f.type === 'select' ? (
            <select className="cf-select" value={values[f.key] || ''} onChange={(e) => set(f.key, e.target.value)}>
              <option value="">— select —</option>
              {f.options.map((o) => <option key={o}>{o}</option>)}
            </select>
          ) : f.type === 'textarea' ? (
            <textarea
              className="inv-textarea"
              rows={3}
              value={values[f.key] || ''}
              onChange={(e) => set(f.key, e.target.value)}
              placeholder={f.placeholder}
            />
          ) : (
            <input
              className="cf-search-input inv-input"
              type={f.type || 'text'}
              value={values[f.key] || ''}
              onChange={(e) => set(f.key, e.target.value)}
              placeholder={f.placeholder}
            />
          )}
        </label>
      ))}
      {error && <div className="aa-error"><AlertTriangle size={16} /> {error}</div>}
      <div className="inv-add-actions">
        <button type="button" className="aa-btn" onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="aa-btn primary" onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </div>
  );
}

function IifBadge({ children }) {
  return <span className="inv-iif-badge">{children}</span>;
}

// Clickable status chip → dropdown of statuses; selection is colour-coded and
// persisted. Lives on the case header (the "main card").
function StatusPicker({ status, onChange }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const pick = async (s) => {
    if (s === status) { setOpen(false); return; }
    setBusy(true);
    try { await onChange(s); } finally { setBusy(false); setOpen(false); }
  };
  return (
    <div className="inv-status-picker" ref={ref}>
      <button
        type="button" className={`aa-chip inv-status-${statusColor(status)} inv-status-btn`}
        onClick={() => setOpen((o) => !o)} disabled={busy} title="Change case status"
      >
        {status} <ChevronDown size={13} />
      </button>
      {open && (
        <div className="inv-status-menu">
          {STATUS_OPTIONS.map((s) => (
            <button key={s} type="button" className={`inv-status-opt ${s === status ? 'active' : ''}`} onClick={() => pick(s)}>
              <span className={`inv-status-dot inv-status-${statusColor(s)}`} /> {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Generic record row with inline edit + delete (and optional drag). `title` is
// the head's left content, `date` its right label, `children` the body. Editing
// swaps the row for a field form built from `fields` (same config as
// AddEntryForm). Every write is a PutObject of the case record — no
// DeleteObject needed, so it works under the Get/Put-only bucket policy.
function EntryRow({ entry, section, fields, title, date, children, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const startEdit = () => {
    const init = {};
    fields.forEach((f) => { init[f.key] = entry[f.key] ?? ''; });
    setVals(init);
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    for (const f of fields) {
      if (f.required && !String(vals[f.key] || '').trim()) { setError(`${f.label} is required.`); return; }
    }
    setBusy(true);
    setError(null);
    try { await onUpdate(section, entry.id, vals); setEditing(false); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const del = async () => {
    setBusy(true);
    setError(null);
    try { await onDelete(section, entry.id); } catch (e) { setError(e.message); setBusy(false); }
  };

  if (editing) {
    return (
      <li className="inv-entry inv-entry-editing">
        <div className="inv-add-form">
          {fields.map((f) => (
            <label key={f.key} className={`inv-field ${f.wide ? 'wide' : ''}`}>
              {f.label}
              {f.type === 'select' ? (
                <select className="cf-select" value={vals[f.key] || ''} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}>
                  <option value="">— select —</option>
                  {f.options.map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : f.type === 'textarea' ? (
                <textarea className="inv-textarea" rows={3} value={vals[f.key] || ''} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />
              ) : (
                <input className="cf-search-input inv-input" type={f.type || 'text'} value={vals[f.key] || ''} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />
              )}
            </label>
          ))}
          {error && <div className="aa-error"><AlertTriangle size={16} /> {error}</div>}
          <div className="inv-add-actions">
            <button type="button" className="aa-btn" onClick={() => { setEditing(false); setError(null); }}>Cancel</button>
            <button type="button" className="aa-btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="inv-entry">
      <div className="inv-entry-head">
        <span className="inv-entry-serial">{title}</span>
        <span className="inv-entry-tools">
          {date != null && <span className="inv-entry-date">{fmtDate(date)}</span>}
          <button type="button" className="inv-icon-btn" title="Edit" onClick={startEdit}><Pencil size={14} /></button>
          <button type="button" className="inv-icon-btn danger" title="Delete" onClick={() => setConfirmDel(true)}><Trash2 size={14} /></button>
        </span>
      </div>
      {children}
      {confirmDel && (
        <div className="inv-confirm">
          <span>Delete this entry? This can’t be undone.</span>
          {error && <span className="inv-confirm-err"><AlertTriangle size={13} /> {error}</span>}
          <div className="inv-confirm-actions">
            <button type="button" className="aa-btn" onClick={() => { setConfirmDel(false); setError(null); }} disabled={busy}>Cancel</button>
            <button type="button" className="aa-btn danger" onClick={del} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button>
          </div>
        </div>
      )}
    </li>
  );
}

function OverviewTab({ rec }) {
  return (
    <div className="inv-overview">
      <IifBadge>{IIF_LABELS.overview}</IifBadge>
      <div className="inv-id-grid">
        <div><span>Investigation ID</span><b>{rec.investigationId}</b></div>
        <div><span>Crime No.</span><b>{rec.crimeNo || '—'}</b></div>
        <div><span>Case No.</span><b>{rec.caseNo || '—'}</b></div>
        <div><span>Case type</span><b>{rec.caseType || '—'}</b></div>
        <div><span>Sections invoked</span><b>{rec.sections || '—'}</b></div>
        <div><span>Police station</span><b>{rec.station || '—'}</b></div>
        <div><span>District</span><b>{rec.district || '—'}</b></div>
        <div><span>Investigating Officer</span><b>{rec.ioRank ? `${rec.ioRank} ` : ''}{rec.ioName || 'Unassigned'}</b></div>
        <div><span>Date of registration</span><b>{rec.registeredDate || '—'}</b></div>
        <div><span>Last diary entry</span><b>{rec.lastDiaryDate || 'None yet'}</b></div>
      </div>
    </div>
  );
}

const DIARY_FIELDS = [
  { key: 'narrative', label: 'Narrative of investigation steps taken', type: 'textarea', wide: true, required: true, placeholder: 'What was done today, in the officer’s own words…' },
  { key: 'placesVisited', label: 'Places visited', placeholder: 'e.g. Scene of offence, complainant residence' },
  { key: 'personsExamined', label: 'Persons examined', placeholder: 'Names / roles' },
  { key: 'departureTime', label: 'Time of departure', type: 'time' },
  { key: 'returnTime', label: 'Time of return', type: 'time' },
];
const DIARY_PER_PAGE = 6;

function DiaryTab({ rec, onAdd, onUpdate, onDelete }) {
  const entries = [...(rec.diaryEntries || [])].sort((a, b) => b.ts - a.ts);
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(entries.length / DIARY_PER_PAGE));
  useEffect(() => { if (page > pages) setPage(pages); }, [page, pages]);
  const shown = entries.slice((page - 1) * DIARY_PER_PAGE, page * DIARY_PER_PAGE);

  return (
    <div className="inv-tab">
      <IifBadge>{IIF_LABELS.diary}</IifBadge>
      <p className="aa-hint">
        Sequential, dated entries of the day's investigation — the legally required Case Diary under
        Section 172 BNSS. Serial numbers are assigned automatically and never reused.
      </p>
      <AddEntryForm
        label="Add diary entry"
        submitLabel="File entry"
        fields={DIARY_FIELDS}
        onSubmit={(v) => {
          if (!v.narrative?.trim()) throw new Error('Narrative is required.');
          return onAdd('diaryEntries', v);
        }}
      />
      <ul className="inv-entry-list">
        {shown.map((e) => (
          <EntryRow
            key={e.id} entry={e} section="diaryEntries" fields={DIARY_FIELDS}
            title={`Diary #${e.serial}`} date={e.ts} onUpdate={onUpdate} onDelete={onDelete}
          >
            <p className="inv-entry-narrative">{e.narrative}</p>
            <div className="inv-entry-meta">
              {e.placesVisited && <span>Places: {e.placesVisited}</span>}
              {e.personsExamined && <span>Examined: {e.personsExamined}</span>}
              {(e.departureTime || e.returnTime) && <span>{e.departureTime || '—'} → {e.returnTime || '—'}</span>}
              <span>by {e.ioName || 'IO'}{e.editedAt ? ' · edited' : ''}</span>
            </div>
          </EntryRow>
        ))}
        {!entries.length && <div className="aa-loading">No diary entries filed yet.</div>}
      </ul>
      {pages > 1 && (
        <div className="inv-pagination">
          <button type="button" className="inv-page-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft size={15} /> Prev
          </button>
          <span className="inv-page-info">Page {page} of {pages}</span>
          <button type="button" className="inv-page-btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next <ChevronRight size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

// Lazy-loaded playback/view control for a stored recording or scanned
// document — nothing is fetched until the officer actually asks for it, and
// every fetch goes through the authenticated /media/get endpoint.
function EvidenceMediaLink({ label, mediaKey, mime }) {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    if (url || loading) return;
    setLoading(true);
    setError(null);
    try {
      setUrl(await fetchEvidenceMediaUrl(mediaKey));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  if (url && mime?.startsWith('audio/')) return <audio controls src={url} className="inv-audio-preview" />;
  if (url) return <a href={url} target="_blank" rel="noreferrer" className="inv-media-btn"><FileText size={13} /> {label}</a>;
  return (
    <button type="button" className="inv-media-btn" onClick={load} disabled={loading}>
      {mime?.startsWith('audio/') ? <Play size={13} /> : <FileText size={13} />}
      {loading ? 'Loading…' : error ? `Failed: ${error}` : label}
    </button>
  );
}

const canRecordAudio =
  typeof window !== 'undefined' &&
  typeof window.MediaRecorder !== 'undefined' &&
  navigator.mediaDevices &&
  typeof navigator.mediaDevices.getUserMedia === 'function';

// Three ways to capture a testimony: type/paste, record live (audio is kept
// as playable evidence AND transcribed live via the same Zia STT pipeline
// the Assistant's voice input uses), or upload a .txt / scanned image (OCR
// via Zia extracts the text; the source file is kept for provenance).
function StatementForm({ caseMasterId, onSubmit }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('type');
  const [personName, setPersonName] = useState('');
  const [role, setRole] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [audioBlob, setAudioBlob] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const recRef = useRef(null);

  const [pendingFile, setPendingFile] = useState(null); // { blob?, key?, name, kind, mime }
  const [ocrBusy, setOcrBusy] = useState(false);

  const reset = () => {
    setPersonName(''); setRole(''); setText('');
    setAudioBlob(null); setAudioUrl(null); setPendingFile(null);
    setMode('type'); setOpen(false); setError(null);
  };

  const toggleMic = async () => {
    if (!canRecordAudio || transcribing) return;
    if (listening) { recRef.current?.stop(); return; }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setListening(false);
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size < 800) return; // skip sub-second blips
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        setTranscribing(true);
        try {
          const t = await transcribeAudio(blob, i18n.resolvedLanguage || 'en');
          setText((cur) => (cur ? cur.replace(/\s+$/, '') + ' ' + t : t));
        } catch (e2) {
          setError('Transcription failed: ' + (e2.message || e2));
        } finally {
          setTranscribing(false);
        }
      };
      recRef.current = rec;
      setListening(true);
      rec.start();
    } catch (e) {
      setError('Microphone unavailable: ' + (e.message || e));
      setListening(false);
    }
  };

  const onFilePick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    if (file.type === 'text/plain' || /\.txt$/i.test(file.name)) {
      const t = await file.text();
      setText((cur) => (cur ? `${cur}\n${t}` : t));
      setPendingFile({ blob: file, name: file.name, kind: 'txt' });
      return;
    }
    if (/^image\/(jpeg|png)$/.test(file.type)) {
      setOcrBusy(true);
      try {
        const { text: extracted, key } = await ocrExtractText(caseMasterId, file, file.name);
        setText((cur) => (cur ? `${cur}\n${extracted}` : extracted));
        setPendingFile({ key, name: file.name, kind: 'image', mime: file.type });
      } catch (e2) {
        setError(e2.message);
      } finally {
        setOcrBusy(false);
      }
      return;
    }
    setError('Only .txt, .jpg or .png are supported — export scanned PDFs as an image first.');
  };

  const submit = async () => {
    if (!personName.trim() || !text.trim()) { setError('Person and testimony text are required.'); return; }
    setBusy(true);
    setError(null);
    try {
      const item = { personName, role: role || 'Witness', text, source: mode };
      if (audioBlob) {
        const up = await uploadEvidenceMedia(caseMasterId, audioBlob, `${personName || 'testimony'}.webm`);
        item.audioKey = up.key;
        item.audioMime = up.mime;
      }
      if (pendingFile) {
        if (pendingFile.kind === 'txt') {
          const up = await uploadEvidenceMedia(caseMasterId, pendingFile.blob, pendingFile.name);
          item.fileKey = up.key; item.fileMime = up.mime; item.fileName = pendingFile.name;
        } else {
          item.fileKey = pendingFile.key; item.fileMime = pendingFile.mime; item.fileName = pendingFile.name;
        }
      }
      await onSubmit(item);
      reset();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="inv-add-btn" onClick={() => setOpen(true)}>
        <Plus size={15} /> Record statement
      </button>
    );
  }

  return (
    <div className="inv-add-form inv-stmt-form">
      <div className="inv-stmt-tools">
        <button
          type="button" className={`inv-mode-icon ${mode === 'record' ? 'active' : ''}`}
          onClick={() => setMode((m) => (m === 'record' ? 'type' : 'record'))}
          disabled={!canRecordAudio}
          title={canRecordAudio ? 'Record live' : 'Microphone recording not supported in this browser'} aria-label="Record live"
        >
          <Mic size={17} />
        </button>
        <button
          type="button" className={`inv-mode-icon ${mode === 'upload' ? 'active' : ''}`}
          onClick={() => setMode((m) => (m === 'upload' ? 'type' : 'upload'))}
          title="Upload file" aria-label="Upload file"
        >
          <Upload size={17} />
        </button>
      </div>

      <label className="inv-field">
        Person examined
        <input className="cf-search-input inv-input" value={personName} onChange={(e) => setPersonName(e.target.value)} placeholder="Full name" />
      </label>
      <label className="inv-field">
        Role
        <select className="cf-select" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">— select —</option>
          {PERSON_ROLES.map((r) => <option key={r}>{r}</option>)}
        </select>
      </label>

      {mode === 'record' && (
        <div className="inv-field wide inv-recorder">
          <button type="button" className={`inv-record-btn ${listening ? 'live' : ''}`} onClick={toggleMic} disabled={transcribing}>
            <Mic size={16} /> {listening ? 'Stop recording' : transcribing ? 'Transcribing…' : 'Start recording'}
          </button>
          {listening && <span className="inv-record-live">● recording — speak now</span>}
          {audioUrl && !listening && <audio controls src={audioUrl} className="inv-audio-preview" />}
          <p className="inv-file-hint">
            Recorded audio is kept as playable evidence and transcribed live below — review and edit the
            transcript before saving.
          </p>
        </div>
      )}
      {mode === 'upload' && (
        <div className="inv-field wide">
          <input type="file" accept=".txt,image/jpeg,image/png" onChange={onFilePick} className="inv-file-input" />
          <p className="inv-file-hint">Upload .txt/.jpg/.png files</p>
          {ocrBusy && <div className="aa-loading">Extracting text…</div>}
          {pendingFile && <div className="inv-file-attached"><Paperclip size={13} /> {pendingFile.name} will be attached</div>}
        </div>
      )}

      <label className="inv-field wide">
        Testimony text {mode !== 'type' && '— review and edit as needed'}
        <textarea className="inv-textarea" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Statement summary…" />
      </label>

      {error && <div className="aa-error"><AlertTriangle size={16} /> {error}</div>}
      <div className="inv-add-actions">
        <button type="button" className="aa-btn" onClick={reset}>Cancel</button>
        <button type="button" className="aa-btn primary" onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : 'Save statement'}
        </button>
      </div>
    </div>
  );
}

function StatementItem({ s, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [personName, setPersonName] = useState(s.personName || '');
  const [role, setRole] = useState(s.role || 'Witness');
  const [text, setText] = useState(s.text || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    if (!personName.trim() || !text.trim()) { setError('Person and testimony text are required.'); return; }
    setBusy(true);
    setError(null);
    try {
      await onUpdate('statements', s.id, { personName, role, text });
      setEditing(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete('statements', s.id);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <li className="inv-entry inv-entry-editing">
        <div className="inv-add-form">
          <label className="inv-field">
            Person examined
            <input className="cf-search-input inv-input" value={personName} onChange={(e) => setPersonName(e.target.value)} />
          </label>
          <label className="inv-field">
            Role
            <select className="cf-select" value={role} onChange={(e) => setRole(e.target.value)}>
              {PERSON_ROLES.map((r) => <option key={r}>{r}</option>)}
            </select>
          </label>
          <label className="inv-field wide">
            Testimony text
            <textarea className="inv-textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          {error && <div className="aa-error"><AlertTriangle size={16} /> {error}</div>}
          <div className="inv-add-actions">
            <button type="button" className="aa-btn" onClick={() => { setEditing(false); setError(null); }}>Cancel</button>
            <button type="button" className="aa-btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="inv-entry">
      <div className="inv-entry-head">
        <span className="inv-entry-serial">{s.personName} <span className="inv-role-chip">{s.role}</span></span>
        <span className="inv-entry-tools">
          <span className="inv-entry-date">{fmtDate(s.ts)}</span>
          <button type="button" className="inv-icon-btn" title="Edit statement" onClick={() => setEditing(true)}><Pencil size={14} /></button>
          <button type="button" className="inv-icon-btn danger" title="Delete statement" onClick={() => setConfirmDel(true)}><Trash2 size={14} /></button>
        </span>
      </div>
      <p className="inv-entry-narrative">{s.text}</p>
      <div className="inv-entry-meta">
        <span>recorded by {s.ioName || 'IO'}{s.editedAt ? ' · edited' : ''}</span>
        {s.audioKey && <EvidenceMediaLink label="Play recording" mediaKey={s.audioKey} mime={s.audioMime} />}
        {s.fileKey && <EvidenceMediaLink label={`View source (${s.fileName || 'file'})`} mediaKey={s.fileKey} mime={s.fileMime} />}
      </div>
      {confirmDel && (
        <div className="inv-confirm">
          <span>Delete this statement? This can’t be undone.</span>
          {error && <span className="inv-confirm-err"><AlertTriangle size={13} /> {error}</span>}
          <div className="inv-confirm-actions">
            <button type="button" className="aa-btn" onClick={() => { setConfirmDel(false); setError(null); }} disabled={busy}>Cancel</button>
            <button type="button" className="aa-btn danger" onClick={del} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button>
          </div>
        </div>
      )}
    </li>
  );
}

function StatementsTab({ rec, caseMasterId, onAdd, onUpdate, onDelete }) {
  const items = [...(rec.statements || [])].sort((a, b) => b.ts - a.ts);
  return (
    <div className="inv-tab">
      <IifBadge>{IIF_LABELS.statements}</IifBadge>
      <p className="aa-hint">
        Statements recorded from witnesses, suspects and complainants during examination — type it, record it
        live, or upload a written/scanned testimony.
      </p>
      <StatementForm caseMasterId={caseMasterId} onSubmit={(item) => onAdd('statements', item)} />
      <ul className="inv-entry-list">
        {items.map((s) => (
          <StatementItem key={s.id} s={s} onUpdate={onUpdate} onDelete={onDelete} />
        ))}
        {!items.length && <div className="aa-loading">No statements recorded yet.</div>}
      </ul>
    </div>
  );
}

const EVIDENCE_FIELDS = [
  { key: 'description', label: 'Description', wide: true, required: true },
  { key: 'type', label: 'Type', type: 'select', options: EVIDENCE_TYPES },
  { key: 'seizureMemoRef', label: 'Seizure memo ref.' },
  { key: 'location', label: 'Stored at' },
  { key: 'fslStatus', label: 'FSL status', type: 'select', options: FSL_STATUSES },
];

function EvidenceTab({ rec, onAdd, onUpdate, onDelete }) {
  const items = [...(rec.evidence || [])].sort((a, b) => b.ts - a.ts);
  return (
    <div className="inv-tab">
      <IifBadge>{IIF_LABELS.evidence}</IifBadge>
      <p className="aa-hint">Seizures and forensic exhibits with chain-of-custody and FSL status.</p>
      <AddEntryForm
        label="Log evidence" submitLabel="Save evidence" fields={EVIDENCE_FIELDS}
        onSubmit={(v) => { if (!v.description?.trim()) throw new Error('Description is required.'); return onAdd('evidence', v); }}
      />
      <ul className="inv-entry-list">
        {items.map((e) => (
          <EntryRow
            key={e.id} entry={e} section="evidence" fields={EVIDENCE_FIELDS}
            title={e.description} date={e.ts} onUpdate={onUpdate} onDelete={onDelete}
          >
            <div className="inv-entry-meta">
              {e.type && <span className="inv-role-chip">{e.type}</span>}
              {e.seizureMemoRef && <span>Memo: {e.seizureMemoRef}</span>}
              {e.location && <span>Stored: {e.location}</span>}
              {e.fslStatus && <span>FSL: {e.fslStatus}</span>}
            </div>
          </EntryRow>
        ))}
        {!items.length && <div className="aa-loading">No evidence logged yet.</div>}
      </ul>
    </div>
  );
}

const PERSON_FIELDS = [
  { key: 'name', label: 'Name', required: true },
  { key: 'role', label: 'Role', type: 'select', options: PERSON_ROLES },
  { key: 'status', label: 'Status', type: 'select', options: PERSON_STATUSES },
  { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
];

function PersonsTab({ rec, onAdd, onUpdate, onDelete }) {
  const items = [...(rec.persons || [])].sort((a, b) => b.ts - a.ts);
  return (
    <div className="inv-tab">
      <p className="aa-hint">
        Complainants, victims, witnesses, suspects and accused tied to this investigation. Cross-case name
        matches are shown as leads to review — never as a conclusion.
      </p>
      <AddEntryForm
        label="Add person" submitLabel="Save person" fields={PERSON_FIELDS}
        onSubmit={(v) => { if (!v.name?.trim()) throw new Error('Name is required.'); return onAdd('persons', v); }}
      />
      <ul className="inv-entry-list">
        {items.map((p) => (
          <EntryRow
            key={p.id} entry={p} section="persons" fields={PERSON_FIELDS}
            onUpdate={onUpdate} onDelete={onDelete}
            title={<>{p.name} <span className="inv-role-chip">{p.role}</span>{p.status && <span className={`aa-chip inv-status-${p.status === 'Arrested' ? 'green' : p.status === 'Absconding' || p.status === 'At large' ? 'red' : 'grey'}`}>{p.status}</span>}</>}
          >
            {p.notes && <p className="inv-entry-narrative">{p.notes}</p>}
            {p.connections?.length > 0 && (
              <div className="inv-connections">
                <Link2 size={13} />
                <span>Also appears in: {p.connections.map((c) => c.crimeNo).join(', ')} — review for possible links.</span>
              </div>
            )}
          </EntryRow>
        ))}
        {!items.length && <div className="aa-loading">No persons recorded yet.</div>}
      </ul>
    </div>
  );
}

const TIMELINE_FIELDS = [
  { key: 'type', label: 'Event type', type: 'select', options: TIMELINE_TYPES },
  { key: 'detail', label: 'Detail', type: 'textarea', wide: true, required: true },
];

function TimelineRow({ t, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [type, setType] = useState(t.type || '');
  const [detail, setDetail] = useState(t.detail || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    if (!detail.trim()) { setError('Detail is required.'); return; }
    setBusy(true);
    setError(null);
    try { await onUpdate('timeline', t.id, { type, detail }); setEditing(false); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const del = async () => {
    setBusy(true);
    setError(null);
    try { await onDelete('timeline', t.id); } catch (e) { setError(e.message); setBusy(false); }
  };

  if (editing) {
    return (
      <li className="inv-timeline-row">
        <span className="inv-timeline-dot" />
        <div className="inv-timeline-body">
          <div className="inv-add-form inv-timeline-edit">
            <label className="inv-field">
              Event type
              <select className="cf-select" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">— select —</option>
                {TIMELINE_TYPES.map((o) => <option key={o}>{o}</option>)}
              </select>
            </label>
            <label className="inv-field wide">
              Detail
              <textarea className="inv-textarea" rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} />
            </label>
            {error && <div className="aa-error"><AlertTriangle size={16} /> {error}</div>}
            <div className="inv-add-actions">
              <button type="button" className="aa-btn" onClick={() => { setEditing(false); setError(null); }}>Cancel</button>
              <button type="button" className="aa-btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
            </div>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="inv-timeline-row">
      <span className="inv-timeline-dot" />
      <div className="inv-timeline-body">
        <div className="inv-timeline-head">
          <b>{t.type || 'Event'}</b>
          <span className="inv-timeline-tools">
            <span>{fmtDateTime(t.ts)}</span>
            <button type="button" className="inv-icon-btn" title="Edit" onClick={() => setEditing(true)}><Pencil size={13} /></button>
            <button type="button" className="inv-icon-btn danger" title="Delete" onClick={() => setConfirmDel(true)}><Trash2 size={13} /></button>
          </span>
        </div>
        <p>{t.detail}</p>
        {confirmDel && (
          <div className="inv-confirm">
            <span>Delete this event? This can’t be undone.</span>
            {error && <span className="inv-confirm-err"><AlertTriangle size={13} /> {error}</span>}
            <div className="inv-confirm-actions">
              <button type="button" className="aa-btn" onClick={() => { setConfirmDel(false); setError(null); }} disabled={busy}>Cancel</button>
              <button type="button" className="aa-btn danger" onClick={del} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

function TimelineTab({ rec, onAdd, onUpdate, onDelete }) {
  const items = [...(rec.timeline || [])].sort((a, b) => b.ts - a.ts);
  return (
    <div className="inv-tab">
      <IifBadge>{IIF_LABELS.timeline}</IifBadge>
      <p className="aa-hint">Chronology of key events on this case, most recent first.</p>
      <AddEntryForm
        label="Add timeline event" submitLabel="Save event" fields={TIMELINE_FIELDS}
        onSubmit={(v) => { if (!v.detail?.trim()) throw new Error('Detail is required.'); return onAdd('timeline', v); }}
      />
      <ul className="inv-timeline">
        {items.map((t) => <TimelineRow key={t.id} t={t} onUpdate={onUpdate} onDelete={onDelete} />)}
        {!items.length && <div className="aa-loading">No events yet.</div>}
      </ul>
    </div>
  );
}

const FINDING_FIELDS = [
  { key: 'type', label: 'Type', type: 'select', options: FINDING_TYPES },
  { key: 'note', label: 'Note', type: 'textarea', wide: true, required: true },
];

function FindingsTab({ rec, onAdd, onUpdate, onDelete }) {
  const items = [...(rec.findings || [])].sort((a, b) => b.ts - a.ts);
  return (
    <div className="inv-tab">
      <p className="aa-hint">Investigator observations, working theories and pending actions — free-form notes, not part of the formal diary.</p>
      <AddEntryForm
        label="Add finding" submitLabel="Save finding" fields={FINDING_FIELDS}
        onSubmit={(v) => { if (!v.note?.trim()) throw new Error('Note is required.'); return onAdd('findings', v); }}
      />
      <ul className="inv-entry-list">
        {items.map((f) => (
          <EntryRow
            key={f.id} entry={f} section="findings" fields={FINDING_FIELDS}
            title={<span className="inv-role-chip">{f.type || 'Observation'}</span>} date={f.ts}
            onUpdate={onUpdate} onDelete={onDelete}
          >
            <p className="inv-entry-narrative">{f.note}</p>
          </EntryRow>
        ))}
        {!items.length && <div className="aa-loading">No findings recorded yet.</div>}
      </ul>
    </div>
  );
}

function SummaryTab({ caseMasterId }) {
  const [state, setState] = useState({ loading: false, summary: null, citations: [], error: null });

  const generate = async () => {
    setState({ loading: true, summary: null, citations: [], error: null });
    try {
      const d = await summarizeInvestigation(caseMasterId);
      setState({ loading: false, summary: d.summary, citations: d.citations || [], error: null });
    } catch (e) {
      setState({ loading: false, summary: null, citations: [], error: e.message });
    }
  };

  return (
    <div className="inv-tab">
      <IifBadge>{IIF_LABELS.summary}</IifBadge>
      <p className="aa-hint">
        A "state of the investigation" brief drafted only from this case's own diary entries, statements,
        timeline and findings — for handover between IOs or when a case is reopened. Always advisory: verify
        every cited entry before relying on it.
      </p>
      <button type="button" className="aa-btn primary" onClick={generate} disabled={state.loading}>
        <Sparkles size={15} /> {state.loading ? 'Drafting…' : 'Generate summary'}
      </button>
      {state.error && <div className="aa-error"><AlertTriangle size={16} /> {state.error}</div>}
      {state.summary && (
        <div className="inv-summary-card">
          <div className="inv-summary-flag">AI-drafted — advisory only, verify against source entries</div>
          <p>{state.summary}</p>
          {state.citations.length > 0 && (
            <div className="inv-citations">
              <span>Sources</span>
              <ol>
                {state.citations.map((c) => <li key={c.n}>[{c.n}] {c.label} — {fmtDate(c.date)}</li>)}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TABS = [
  { key: 'overview', label: 'Overview', Icon: NotebookPen },
  { key: 'diary', label: 'Case Diary', Icon: MessageSquareQuote },
  { key: 'statements', label: 'Statements', Icon: Users },
  { key: 'evidence', label: 'Evidence', Icon: Fingerprint },
  { key: 'persons', label: 'Persons', Icon: Users },
  { key: 'timeline', label: 'Timeline', Icon: Clock },
  { key: 'findings', label: 'Findings', Icon: ListChecks },
  { key: 'summary', label: 'AI Summary', Icon: Sparkles },
];

export default function InvestigationCase() {
  const { caseMasterId } = useParams();
  const navigate = useNavigate();
  const [rec, setRec] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('overview');
  const [tabMenuOpen, setTabMenuOpen] = useState(false);

  const load = useCallback(() => {
    getInvestigation(caseMasterId).then((r) => {
      if (!r) setError('Investigation record not found.');
      else setRec(r);
    }).catch((e) => setError(e.message));
  }, [caseMasterId]);
  useEffect(load, [load]);

  const onAdd = async (section, item) => {
    const d = await appendInvestigationItem(caseMasterId, section, item);
    setRec(d.record);
  };
  const onUpdate = async (section, entryId, patch) => {
    setRec(await updateInvestigationItem(caseMasterId, section, entryId, patch));
  };
  const onDelete = async (section, entryId) => {
    setRec(await deleteInvestigationItem(caseMasterId, section, entryId));
  };
  const onStatusChange = async (status) => {
    const updated = await setInvestigationStatus(caseMasterId, status);
    setRec(updated);
  };
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const exportPdf = async () => {
    setExporting(true);
    setExportError(null);
    try { await exportInvestigationDiaryPdf(rec); }
    catch (e) { setExportError(e.message); } finally { setExporting(false); }
  };

  if (error) {
    return (
      <div className="cf-page">
        <TopBar title="Investigation Diary" />
        <div className="pp-body"><div className="aa-error"><AlertTriangle size={16} /> {error}</div></div>
      </div>
    );
  }
  if (!rec) {
    return (
      <div className="cf-page">
        <TopBar title="Investigation Diary" />
        <div className="pp-body"><div className="aa-loading">Loading investigation…</div></div>
      </div>
    );
  }

  const active = TABS.find((t) => t.key === tab) || TABS[0];

  return (
    <div className="cf-page">
      <TopBar title={rec.crimeNo || `Case ${rec.caseMasterId}`} parent="Investigation Diary" />
      <div className="pp-body">
        <div className="inv-case-head">
          <div>
            <button type="button" className="inv-back" onClick={() => navigate('/investigation-diary')}>← All investigations</button>
            <h1>{rec.crimeNo || `Case ${rec.caseMasterId}`}</h1>
            <p>{rec.caseType || 'Uncategorised'}{rec.sections ? ` · ${rec.sections}` : ''}</p>
          </div>
          <div className="inv-head-actions">
            <button type="button" className="aa-btn" onClick={exportPdf} disabled={exporting}>
              <FileDown size={14} /> {exporting ? 'Preparing…' : 'Export PDF'}
            </button>
            <StatusPicker status={rec.status} onChange={onStatusChange} />
          </div>
        </div>
        {exportError && <div className="aa-error"><AlertTriangle size={16} /> {exportError}</div>}

        <div className="inv-tabbar">
          {TABS.map((t) => (
            <button key={t.key} className={`inv-tab-btn ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              <t.Icon size={14} /> {t.label}
            </button>
          ))}
        </div>
        <div className="inv-tabbar-mobile">
          <button type="button" className="inv-tab-mobile-btn" onClick={() => setTabMenuOpen((o) => !o)}>
            <active.Icon size={14} /> {active.label} <ChevronDown size={14} />
          </button>
          {tabMenuOpen && (
            <div className="inv-tab-mobile-menu">
              {TABS.map((t) => (
                <button key={t.key} onClick={() => { setTab(t.key); setTabMenuOpen(false); }}>
                  <t.Icon size={14} /> {t.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {tab === 'overview' && <OverviewTab rec={rec} />}
        {tab === 'diary' && <DiaryTab rec={rec} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} />}
        {tab === 'statements' && <StatementsTab rec={rec} caseMasterId={rec.caseMasterId} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} />}
        {tab === 'evidence' && <EvidenceTab rec={rec} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} />}
        {tab === 'persons' && <PersonsTab rec={rec} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} />}
        {tab === 'timeline' && <TimelineTab rec={rec} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} />}
        {tab === 'findings' && <FindingsTab rec={rec} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} />}
        {tab === 'summary' && <SummaryTab caseMasterId={rec.caseMasterId} />}
      </div>
    </div>
  );
}
