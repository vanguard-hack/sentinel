import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  NotebookPen, AlertTriangle, Plus, Sparkles, ListChecks, Users, Fingerprint,
  MessageSquareQuote, Clock, ShieldAlert, Link2, ChevronDown,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import {
  getInvestigation, setInvestigationStatus, appendInvestigationItem, summarizeInvestigation,
  coldCaseFlag, nextStepSuggestions, statusColor, IIF_LABELS,
  STATUS_OPTIONS, PERSON_ROLES, PERSON_STATUSES, EVIDENCE_TYPES, FSL_STATUSES, TIMELINE_TYPES, FINDING_TYPES,
} from '../utils/investigation';

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

function OverviewTab({ rec, onStatusChange }) {
  const cold = coldCaseFlag(rec);
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
      <div className="inv-status-row">
        <span>Case status</span>
        <select className="cf-select" value={rec.status} onChange={(e) => onStatusChange(e.target.value)}>
          {STATUS_OPTIONS.map((s) => <option key={s}>{s}</option>)}
        </select>
        {cold && <span className={`inv-cold-badge inv-cold-${cold.level}`}>{cold.label}</span>}
      </div>
    </div>
  );
}

function DiaryTab({ rec, onAdd }) {
  const entries = [...(rec.diaryEntries || [])].sort((a, b) => b.ts - a.ts);
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
        fields={[
          { key: 'narrative', label: 'Narrative of investigation steps taken', type: 'textarea', wide: true, placeholder: 'What was done today, in the officer’s own words…' },
          { key: 'placesVisited', label: 'Places visited', placeholder: 'e.g. Scene of offence, complainant residence' },
          { key: 'personsExamined', label: 'Persons examined', placeholder: 'Names / roles' },
          { key: 'departureTime', label: 'Time of departure', type: 'time' },
          { key: 'returnTime', label: 'Time of return', type: 'time' },
        ]}
        onSubmit={(v) => {
          if (!v.narrative?.trim()) throw new Error('Narrative is required.');
          return onAdd('diaryEntries', v);
        }}
      />
      <ul className="inv-entry-list">
        {entries.map((e) => (
          <li key={e.id} className="inv-entry">
            <div className="inv-entry-head">
              <span className="inv-entry-serial">Diary #{e.serial}</span>
              <span className="inv-entry-date">{fmtDate(e.ts)}</span>
            </div>
            <p className="inv-entry-narrative">{e.narrative}</p>
            <div className="inv-entry-meta">
              {e.placesVisited && <span>Places: {e.placesVisited}</span>}
              {e.personsExamined && <span>Examined: {e.personsExamined}</span>}
              {(e.departureTime || e.returnTime) && <span>{e.departureTime || '—'} → {e.returnTime || '—'}</span>}
              <span>by {e.ioName || 'IO'}</span>
            </div>
          </li>
        ))}
        {!entries.length && <div className="aa-loading">No diary entries filed yet.</div>}
      </ul>
    </div>
  );
}

function StatementsTab({ rec, onAdd }) {
  const items = [...(rec.statements || [])].sort((a, b) => b.ts - a.ts);
  return (
    <div className="inv-tab">
      <IifBadge>{IIF_LABELS.statements}</IifBadge>
      <p className="aa-hint">Statements recorded from witnesses, suspects and complainants during examination.</p>
      <AddEntryForm
        label="Record statement"
        submitLabel="Save statement"
        fields={[
          { key: 'personName', label: 'Person examined' },
          { key: 'role', label: 'Role', type: 'select', options: PERSON_ROLES },
          { key: 'text', label: 'Statement summary', type: 'textarea', wide: true },
        ]}
        onSubmit={(v) => {
          if (!v.personName?.trim() || !v.text?.trim()) throw new Error('Person and statement text are required.');
          return onAdd('statements', v);
        }}
      />
      <ul className="inv-entry-list">
        {items.map((s) => (
          <li key={s.id} className="inv-entry">
            <div className="inv-entry-head">
              <span className="inv-entry-serial">{s.personName} <span className="inv-role-chip">{s.role}</span></span>
              <span className="inv-entry-date">{fmtDate(s.ts)}</span>
            </div>
            <p className="inv-entry-narrative">{s.text}</p>
            <div className="inv-entry-meta"><span>recorded by {s.ioName || 'IO'}</span></div>
          </li>
        ))}
        {!items.length && <div className="aa-loading">No statements recorded yet.</div>}
      </ul>
    </div>
  );
}

function EvidenceTab({ rec, onAdd }) {
  const items = [...(rec.evidence || [])].sort((a, b) => b.ts - a.ts);
  return (
    <div className="inv-tab">
      <IifBadge>{IIF_LABELS.evidence}</IifBadge>
      <p className="aa-hint">Seizures and forensic exhibits with chain-of-custody and FSL status.</p>
      <AddEntryForm
        label="Log evidence"
        submitLabel="Save evidence"
        fields={[
          { key: 'description', label: 'Description', wide: true },
          { key: 'type', label: 'Type', type: 'select', options: EVIDENCE_TYPES },
          { key: 'seizureMemoRef', label: 'Seizure memo ref.' },
          { key: 'location', label: 'Stored at' },
          { key: 'fslStatus', label: 'FSL status', type: 'select', options: FSL_STATUSES },
        ]}
        onSubmit={(v) => {
          if (!v.description?.trim()) throw new Error('Description is required.');
          return onAdd('evidence', v);
        }}
      />
      <ul className="inv-entry-list">
        {items.map((e) => (
          <li key={e.id} className="inv-entry">
            <div className="inv-entry-head">
              <span className="inv-entry-serial">{e.description}</span>
              <span className="inv-entry-date">{fmtDate(e.ts)}</span>
            </div>
            <div className="inv-entry-meta">
              {e.type && <span className="inv-role-chip">{e.type}</span>}
              {e.seizureMemoRef && <span>Memo: {e.seizureMemoRef}</span>}
              {e.location && <span>Stored: {e.location}</span>}
              {e.fslStatus && <span>FSL: {e.fslStatus}</span>}
            </div>
          </li>
        ))}
        {!items.length && <div className="aa-loading">No evidence logged yet.</div>}
      </ul>
    </div>
  );
}

function PersonsTab({ rec, onAdd }) {
  const items = [...(rec.persons || [])].sort((a, b) => b.ts - a.ts);
  return (
    <div className="inv-tab">
      <p className="aa-hint">
        Complainants, victims, witnesses, suspects and accused tied to this investigation. Cross-case name
        matches are shown as leads to review — never as a conclusion.
      </p>
      <AddEntryForm
        label="Add person"
        submitLabel="Save person"
        fields={[
          { key: 'name', label: 'Name' },
          { key: 'role', label: 'Role', type: 'select', options: PERSON_ROLES },
          { key: 'status', label: 'Status', type: 'select', options: PERSON_STATUSES },
          { key: 'notes', label: 'Notes', type: 'textarea', wide: true },
        ]}
        onSubmit={(v) => {
          if (!v.name?.trim()) throw new Error('Name is required.');
          return onAdd('persons', v);
        }}
      />
      <ul className="inv-entry-list">
        {items.map((p) => (
          <li key={p.id} className="inv-entry">
            <div className="inv-entry-head">
              <span className="inv-entry-serial">{p.name} <span className="inv-role-chip">{p.role}</span></span>
              {p.status && <span className={`aa-chip inv-status-${p.status === 'Arrested' ? 'green' : p.status === 'Absconding' || p.status === 'At large' ? 'red' : 'grey'}`}>{p.status}</span>}
            </div>
            {p.notes && <p className="inv-entry-narrative">{p.notes}</p>}
            {p.connections?.length > 0 && (
              <div className="inv-connections">
                <Link2 size={13} />
                <span>Also appears in: {p.connections.map((c) => c.crimeNo).join(', ')} — review for possible links.</span>
              </div>
            )}
          </li>
        ))}
        {!items.length && <div className="aa-loading">No persons recorded yet.</div>}
      </ul>
    </div>
  );
}

function TimelineTab({ rec, onAdd }) {
  // Pure structured extraction — every timestamped sub-record merged and
  // sorted, no model call involved.
  const merged = useMemo(() => {
    const rows = [];
    (rec.timeline || []).forEach((t) => rows.push({ id: t.id, ts: t.ts, kind: t.type || 'Event', detail: t.detail }));
    (rec.diaryEntries || []).forEach((e) => rows.push({ id: e.id, ts: e.ts, kind: 'Diary entry', detail: `Diary #${e.serial} filed` }));
    (rec.statements || []).forEach((s) => rows.push({ id: s.id, ts: s.ts, kind: 'Statement', detail: `${s.personName} (${s.role})` }));
    (rec.evidence || []).forEach((e) => rows.push({ id: e.id, ts: e.ts, kind: 'Evidence', detail: e.description }));
    return rows.sort((a, b) => b.ts - a.ts);
  }, [rec]);

  return (
    <div className="inv-tab">
      <IifBadge>{IIF_LABELS.timeline}</IifBadge>
      <p className="aa-hint">Auto-generated chronology of every timestamped event on this case, newest first.</p>
      <AddEntryForm
        label="Add timeline event"
        submitLabel="Save event"
        fields={[
          { key: 'type', label: 'Event type', type: 'select', options: TIMELINE_TYPES },
          { key: 'detail', label: 'Detail', type: 'textarea', wide: true },
        ]}
        onSubmit={(v) => {
          if (!v.detail?.trim()) throw new Error('Detail is required.');
          return onAdd('timeline', v);
        }}
      />
      <ul className="inv-timeline">
        {merged.map((r) => (
          <li key={r.id} className="inv-timeline-row">
            <span className="inv-timeline-dot" />
            <div>
              <div className="inv-timeline-head"><b>{r.kind}</b><span>{fmtDateTime(r.ts)}</span></div>
              <p>{r.detail}</p>
            </div>
          </li>
        ))}
        {!merged.length && <div className="aa-loading">No events yet.</div>}
      </ul>
    </div>
  );
}

function FindingsTab({ rec, onAdd }) {
  const items = [...(rec.findings || [])].sort((a, b) => b.ts - a.ts);
  return (
    <div className="inv-tab">
      <p className="aa-hint">Investigator observations, working theories and pending actions — free-form notes, not part of the formal diary.</p>
      <AddEntryForm
        label="Add finding"
        submitLabel="Save finding"
        fields={[
          { key: 'type', label: 'Type', type: 'select', options: FINDING_TYPES },
          { key: 'note', label: 'Note', type: 'textarea', wide: true },
        ]}
        onSubmit={(v) => {
          if (!v.note?.trim()) throw new Error('Note is required.');
          return onAdd('findings', v);
        }}
      />
      <ul className="inv-entry-list">
        {items.map((f) => (
          <li key={f.id} className="inv-entry">
            <div className="inv-entry-head">
              <span className="inv-role-chip">{f.type || 'Observation'}</span>
              <span className="inv-entry-date">{fmtDate(f.ts)}</span>
            </div>
            <p className="inv-entry-narrative">{f.note}</p>
          </li>
        ))}
        {!items.length && <div className="aa-loading">No findings recorded yet.</div>}
      </ul>
    </div>
  );
}

function NextStepsTab({ rec }) {
  const steps = nextStepSuggestions(rec);
  return (
    <div className="inv-tab">
      <IifBadge>{IIF_LABELS.nextSteps}</IifBadge>
      <p className="aa-hint">
        A rule-based checklist of gaps in the record — a reminder, not a decision. Nothing here is generated
        by a model.
      </p>
      {steps.length === 0 ? (
        <div className="inv-clean">No outstanding gaps detected in the record right now.</div>
      ) : (
        <ul className="inv-steps">
          {steps.map((s) => (
            <li key={s.id}><ShieldAlert size={15} /> {s.text}</li>
          ))}
        </ul>
      )}
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
  { key: 'next-steps', label: 'Next steps', Icon: ShieldAlert },
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
  const onStatusChange = async (status) => {
    const updated = await setInvestigationStatus(caseMasterId, status);
    setRec(updated);
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
          <span className={`aa-chip inv-status-${statusColor(rec.status)}`}>{rec.status}</span>
        </div>

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

        {tab === 'overview' && <OverviewTab rec={rec} onStatusChange={onStatusChange} />}
        {tab === 'diary' && <DiaryTab rec={rec} onAdd={onAdd} />}
        {tab === 'statements' && <StatementsTab rec={rec} onAdd={onAdd} />}
        {tab === 'evidence' && <EvidenceTab rec={rec} onAdd={onAdd} />}
        {tab === 'persons' && <PersonsTab rec={rec} onAdd={onAdd} />}
        {tab === 'timeline' && <TimelineTab rec={rec} onAdd={onAdd} />}
        {tab === 'findings' && <FindingsTab rec={rec} onAdd={onAdd} />}
        {tab === 'next-steps' && <NextStepsTab rec={rec} />}
        {tab === 'summary' && <SummaryTab caseMasterId={rec.caseMasterId} />}
      </div>
    </div>
  );
}
