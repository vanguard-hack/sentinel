// The morning action queue.
//
// Everything else in Sentinel answers "what happened?". This answers "what do
// I do before lunch?", which is a different question and the one an officer
// actually opens a system to ask.
//
// The design rule for every card: a finding is a claim about the FILE, a
// consequence is what the law does about it, and an action is what to do. The
// consequence is the part that earns the card its place — "no witness
// statements" is a checklist item that gets ignored, "no independent
// corroboration, and an accused in custody on it" is a reason to move today.
//
// Two things kept deliberately visible:
//   • Legal citations are marked unverified, matching the rest of the legal
//     layer. A countdown that cites a section is more useful than one that
//     does not, but only if nobody is invited to rely on the number.
//   • Every obligation can be dismissed as done-off-system with a reason. An
//     alert that cannot be dismissed is an alert officers learn to scroll
//     past, and that is how this page would die.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, CalendarClock, Check, CheckCircle2, ChevronDown, ClipboardCheck,
  Clock, ExternalLink, Loader2, RefreshCw, RotateCcw, Scale, ShieldAlert,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import { logAudit } from '../utils/audit';
import {
  fetchActionQueue, acknowledgeObligation, reopenObligation,
  SEVERITY, KIND_LABEL, countdown, citation,
} from '../utils/actionQueue';

const KIND_ICONS = {
  statutory: Scale,
  physical: Clock,
  admissibility: ShieldAlert,
  procedural: ClipboardCheck,
};

export default function ActionQueue() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('all'); // all | mine
  const [acking, setAcking] = useState(null); // obligation key being dismissed
  const [note, setNote] = useState('');
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setData(await fetchActionQueue());
    } catch (e) {
      setError(e?.message || 'The action queue could not be loaded.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const keyOf = (o) => `${o.caseMasterId}::${o.id}`;

  const { open, done } = useMemo(() => {
    const all = data?.obligations || [];
    const scoped = scope === 'mine' ? all.filter((o) => o.mine) : all;
    return {
      open: scoped.filter((o) => !o.acknowledged),
      done: scoped.filter((o) => o.acknowledged),
    };
  }, [data, scope]);

  const counts = useMemo(() => ({
    overdue: open.filter((o) => o.severity === 'overdue').length,
    critical: open.filter((o) => o.severity === 'critical').length,
    high: open.filter((o) => o.severity === 'high').length,
    cases: new Set(open.map((o) => o.caseMasterId)).size,
  }), [open]);

  const submitAck = async (o) => {
    if (!note.trim()) return;
    try {
      await acknowledgeObligation(o.caseMasterId, o.id, note.trim());
      logAudit('acknowledge-obligation', 'Action Queue', `${o.crimeNo} · ${o.id}`);
      setAcking(null);
      setNote('');
      await load();
    } catch (e) {
      setError(e?.message || 'Could not record that.');
    }
  };

  const undo = async (o) => {
    try {
      await reopenObligation(o.caseMasterId, o.id);
      logAudit('reopen-obligation', 'Action Queue', `${o.crimeNo} · ${o.id}`);
      await load();
    } catch (e) {
      setError(e?.message || 'Could not reopen that.');
    }
  };

  return (
    <div className="page">
      <TopBar title="Action Queue" subtitle="What breaks first, across every open case" />

      {/* ── Headline ────────────────────────────────────────────────────── */}
      <div className={`aq-head ${counts.overdue ? 'overdue' : counts.critical ? 'critical' : 'calm'}`}>
        <div className="aq-head-main">
          <h2>
            {open.length === 0
              ? 'Nothing needs action today'
              : `${open.length} obligation${open.length === 1 ? '' : 's'} across ${counts.cases} case${counts.cases === 1 ? '' : 's'}`}
          </h2>
          <p>
            {open.length === 0
              ? 'Every open case is within its statutory windows and has no outstanding evidentiary gap on file.'
              : [
                  counts.overdue ? `${counts.overdue} overdue` : null,
                  counts.critical ? `${counts.critical} critical` : null,
                  counts.high ? `${counts.high} high` : null,
                ].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="aq-head-tools">
          <div className="aq-scope">
            <button type="button" className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All cases</button>
            <button type="button" className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>Mine</button>
          </div>
          <button type="button" className="aq-refresh" onClick={load} disabled={busy} title="Refresh">
            {busy ? <Loader2 size={14} className="aq-spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>

      {error && <div className="aq-error"><AlertTriangle size={15} /> {error}</div>}
      {!data && !error && <div className="aq-loading"><Loader2 size={18} className="aq-spin" /> Reading the case files…</div>}

      {data?.capped && (
        <p className="aq-note">
          Showing the {data.scanned} most recently updated open cases. Settled cases are excluded —
          they carry no live obligation.
        </p>
      )}

      {/* ── The queue ───────────────────────────────────────────────────── */}
      <div className="aq-list">
        {open.map((o) => {
          const k = keyOf(o);
          const sev = SEVERITY[o.severity] || SEVERITY.medium;
          const Icon = KIND_ICONS[o.kind] || ClipboardCheck;
          const cd = countdown(o.clock);
          const cite = citation(o.authority);
          return (
            <article key={k} className={`aq-card ${sev.tone}`}>
              <header className="aq-card-head">
                <span className={`aq-sev ${sev.tone}`}>{sev.label}</span>
                <span className="aq-kind"><Icon size={11} /> {KIND_LABEL[o.kind] || o.kind}</span>
                {cd && (
                  <span className={`aq-clock ${cd.over ? 'over' : ''}`}>
                    <CalendarClock size={12} /> {cd.text}
                  </span>
                )}
                <Link to={`/investigation-diary/${o.caseMasterId}`} className="aq-case">
                  {o.crimeNo} <ExternalLink size={11} />
                </Link>
              </header>

              <h3>{o.title}</h3>
              <p className="aq-finding">{o.finding}</p>
              <p className="aq-consequence">{o.consequence}</p>

              {(cite || o.basis) && (
                <div className="aq-meta">
                  {cite && (
                    <span className="aq-cite" title={o.authority?.title || ''}>
                      <Scale size={11} /> {cite}
                      {o.authority?.verified === false && <em>unverified</em>}
                    </span>
                  )}
                  {o.basis && <span className={`aq-basis ${o.certain ? '' : 'soft'}`}>{o.basis}</span>}
                </div>
              )}

              <div className="aq-action">
                <span><strong>Next:</strong> {o.action}</span>
              </div>

              {acking === k ? (
                <div className="aq-ack">
                  <label htmlFor={`n-${k}`}>
                    What was done? A supervisor reviewing the queue sees this.
                  </label>
                  <textarea
                    id={`n-${k}`}
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. Seizure panchanama filed on paper 04/02, not yet entered."
                  />
                  <div className="aq-ack-btns">
                    <button type="button" className="aq-btn ghost" onClick={() => { setAcking(null); setNote(''); }}>
                      Cancel
                    </button>
                    <button type="button" className="aq-btn solid" disabled={!note.trim()} onClick={() => submitAck(o)}>
                      <Check size={13} /> Mark done
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="aq-dismiss"
                  onClick={() => { setAcking(k); setNote(''); }}
                >
                  Already handled off-system
                </button>
              )}
            </article>
          );
        })}
      </div>

      {open.length === 0 && data && (
        <div className="aq-clear">
          <CheckCircle2 size={22} />
          <p>
            {scope === 'mine'
              ? 'None of your cases has an outstanding obligation.'
              : 'No open case has an outstanding statutory or evidentiary obligation on file.'}
          </p>
        </div>
      )}

      {/* ── Acknowledged ────────────────────────────────────────────────── */}
      {done.length > 0 && (
        <div className="aq-done">
          <button type="button" className="aq-done-head" onClick={() => setShowDone((v) => !v)}>
            <ChevronDown size={14} className={showDone ? 'open' : ''} />
            {done.length} marked handled off-system
          </button>
          {showDone && done.map((o) => (
            <div key={keyOf(o)} className="aq-done-row">
              <div>
                <b>{o.crimeNo}</b> — {o.title}
                <span className="aq-done-note">
                  “{o.acknowledged.note}” · {o.acknowledged.by}
                </span>
              </div>
              <button type="button" className="aq-btn ghost" onClick={() => undo(o)}>
                <RotateCcw size={12} /> Reopen
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="aq-foot">
        Computed from what is recorded in each case file — nothing here is a judgement about an
        officer, and a step completed on paper but not yet entered will appear as outstanding until
        it is entered or marked handled. Section references are an operational aid drafted for this
        prototype and are not verified against the bare acts; the finding and its consequence stand
        on their own.
      </p>
    </div>
  );
}
