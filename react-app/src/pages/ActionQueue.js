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
//
// LAID OUT AS A TABLE, NOT A COLUMN OF CARDS
//
// The first version gave every obligation a tall card carrying its finding,
// consequence, citation and action. That reads well for three obligations and
// is unusable for forty: a supervisor scrolls past the one thing they opened
// the page to find, and the page's own claim — that it sorts itself — is
// invisible when only two rows fit on screen.
//
// So the queue is a sortable table with one line per obligation, and the prose
// lives behind a row that expands. Nothing was dropped; it is simply no longer
// all shouted at once. The counts moved into stat tiles at the top for the same
// reason — "3 overdue" is the number a supervisor came for, and it should not
// have to be assembled from a sentence.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, CalendarClock, Check, CheckCircle2, ChevronDown, ChevronsUpDown,
  ClipboardCheck, Clock, ExternalLink, Flame, Loader2, RefreshCw, RotateCcw,
  Scale, ShieldAlert, Timer,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import { logAudit } from '../utils/audit';
import {
  fetchActionQueue, acknowledgeObligation, reopenObligation,
  SEVERITY, KIND_LABEL, countdown, citation, byOfficer, canCommand,
  initials, avatarTone, deadlineChip, sortObligations,
} from '../utils/actionQueue';

const KIND_ICONS = {
  statutory: Scale,
  physical: Clock,
  admissibility: ShieldAlert,
  procedural: ClipboardCheck,
};

// The four tiles. Deliberately not "total obligations": a total tells a
// supervisor nothing they can act on, whereas "3 overdue" is the number they
// opened the page for. Cases sits last as the denominator that gives the rest
// their scale — nine obligations across nine files is a bad week, nine across
// one file is a single case in trouble.
const TILES = [
  { key: 'overdue', label: 'Overdue', hint: 'past the statutory date', Icon: Flame, tone: 'overdue' },
  { key: 'critical', label: 'Critical', hint: 'inside a week', Icon: AlertTriangle, tone: 'critical' },
  { key: 'high', label: 'High', hint: 'needs attention', Icon: Timer, tone: 'high' },
  { key: 'cases', label: 'Cases affected', hint: 'files with something outstanding', Icon: ClipboardCheck, tone: 'neutral' },
];

const COLUMNS = [
  { key: 'severity', label: 'Priority', sortable: true },
  { key: 'crimeNo', label: 'Case', sortable: true },
  { key: 'title', label: 'Obligation', sortable: true },
  { key: 'kind', label: 'Type', sortable: true },
  { key: 'officer', label: 'Officer', sortable: true },
  { key: 'deadline', label: 'Deadline', sortable: true },
  { key: 'actions', label: '', sortable: false },
];

export default function ActionQueue() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('all'); // all | mine | command
  const [acking, setAcking] = useState(null); // obligation key being dismissed
  const [note, setNote] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [sort, setSort] = useState({ key: 'severity', dir: 'asc' });
  const [openRow, setOpenRow] = useState(null); // the obligation showing its prose

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

  const command = canCommand(data?.role);
  const officers = useMemo(
    () => (command ? byOfficer(data?.obligations || []) : []),
    [data, command],
  );

  const { open, done } = useMemo(() => {
    const all = data?.obligations || [];
    const scoped = scope === 'mine' ? all.filter((o) => o.mine) : all;
    return {
      open: scoped.filter((o) => !o.acknowledged),
      done: scoped.filter((o) => o.acknowledged),
    };
  }, [data, scope]);

  const rows = useMemo(() => sortObligations(open, sort.key, sort.dir), [open, sort]);

  const toggleSort = (key) => setSort((s0) =>
    (s0.key === key ? { key, dir: s0.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

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
      {/* The verdict waits for data. Rendering it from an empty list means the
          page announces "Nothing needs action today" for as long as the fetch
          takes and then contradicts itself — an all-clear is the one message
          that must never appear before it has been earned. */}
      <div className="aq-bar">
        <div className="aq-bar-main">
          <h2>
            {!data
              ? 'Checking every open case…'
              : open.length === 0
              ? 'Nothing needs action today'
              : `${open.length} obligation${open.length === 1 ? '' : 's'} outstanding`}
          </h2>
          <p>
            {!data
              ? 'Reading the case diaries for statutory deadlines and evidentiary gaps.'
              : open.length === 0
              ? 'Every open case is within its statutory windows with no outstanding gap on file.'
              : `Across ${counts.cases} case${counts.cases === 1 ? '' : 's'}, ordered by what breaks first.`}
          </p>
        </div>
        <div className="aq-bar-tools">
          <div className="aq-scope" role="group" aria-label="Which cases to show">
            <button type="button" className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All cases</button>
            <button type="button" className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>Mine</button>
            {command && (
              <button type="button" className={scope === 'command' ? 'on' : ''} onClick={() => setScope('command')}>
                By officer
              </button>
            )}
          </div>
          <button type="button" className="aq-refresh" onClick={load} disabled={busy} aria-label="Refresh">
            {busy ? <Loader2 size={14} className="aq-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/* ── The four numbers ────────────────────────────────────────────── */}
      {scope !== 'command' && (
        <div className="aq-tiles">
          {TILES.map((t) => (
            // A zero must LOOK calm. The tone class is dropped when the count
            // is nothing, because a red tile reading "0 overdue" is the page
            // crying wolf every morning, which is precisely how it stops being
            // read. (Tried this in CSS with :has(b:empty) — it cannot test text
            // content, so it matched always and did the opposite.)
            <div key={t.key} className={`aq-tile ${data && counts[t.key] > 0 ? t.tone : 'neutral'}`}>
              <span className="aq-tile-icon"><t.Icon size={18} aria-hidden="true" /></span>
              <span className="aq-tile-body">
                <b>{data ? counts[t.key] : '—'}</b>
                <span className="aq-tile-label">{t.label}</span>
              </span>
              <span className="aq-tile-hint">{t.hint}</span>
            </div>
          ))}
        </div>
      )}

      {error && <div className="aq-error"><AlertTriangle size={15} /> {error}</div>}
      {!data && !error && <div className="aq-loading"><Loader2 size={18} className="aq-spin" /> Reading the case files…</div>}


      {data?.capped && (
        <p className="aq-note">
          Showing the {data.scanned} most recently updated open cases. Settled cases are excluded —
          they carry no live obligation.
        </p>
      )}

      {/* ── Command view ────────────────────────────────────────────────── */}
      {/* A supervisor is asking a different question: not "what do I do next"
          but "who is carrying risk I should know about". Ordered by the nearest
          running clock rather than by volume — one officer twelve days from a
          default-bail release outranks another with nine procedural gaps and
          nothing counting down. */}
      {scope === 'command' && (
        <div className="aq-cmd">
          {officers.length === 0 && (
            <div className="aq-clear">
              <CheckCircle2 size={22} />
              <p>No officer is carrying an outstanding obligation.</p>
            </div>
          )}
          {officers.map((g) => {
            const sev = SEVERITY[g.worst] || SEVERITY.medium;
            return (
              <article key={g.officer} className={`aq-officer ${sev.tone}`}>
                <div className="aq-officer-id">
                  <h3>{g.officer}</h3>
                  {g.station && <span>{g.station}</span>}
                </div>
                <div className="aq-officer-nums">
                  <span className="aq-officer-fig"><b>{g.total}</b> obligation{g.total === 1 ? '' : 's'}</span>
                  <span className="aq-officer-fig"><b>{g.cases}</b> case{g.cases === 1 ? '' : 's'}</span>
                  {g.overdue > 0 && <span className="aq-pill overdue">{g.overdue} overdue</span>}
                  {g.critical > 0 && <span className="aq-pill critical">{g.critical} critical</span>}
                  {g.high > 0 && <span className="aq-pill high">{g.high} high</span>}
                </div>
                <div className="aq-officer-clock">
                  {g.soonest === null ? (
                    <span className="aq-officer-none">No deadline running</span>
                  ) : (
                    <span className={g.soonest <= 0 ? 'over' : ''}>
                      <CalendarClock size={13} />
                      {g.soonest <= 0
                        ? `${Math.abs(g.soonest)} day${Math.abs(g.soonest) === 1 ? '' : 's'} overdue`
                        : `nearest deadline in ${g.soonest} day${g.soonest === 1 ? '' : 's'}`}
                    </span>
                  )}
                </div>
                <ul className="aq-officer-cases">
                  {g.items.slice(0, 3).map((o) => (
                    <li key={`${o.caseMasterId}-${o.id}`}>
                      <Link to={`/investigation-diary/${o.caseMasterId}`}>{o.crimeNo}</Link>
                      <span>{o.title}</span>
                    </li>
                  ))}
                  {g.items.length > 3 && <li className="more">and {g.items.length - 3} more</li>}
                </ul>
              </article>
            );
          })}
        </div>
      )}

      {/* ── The queue ───────────────────────────────────────────────────── */}
      {/* Rendered conditionally rather than hidden with the `hidden` attribute:
          the table sets its own display, and an author rule beats the UA
          stylesheet's [hidden]{display:none}, so the attribute alone would
          leave both this and the command panel on screen at once. */}
      {scope !== 'command' && rows.length > 0 && (
        <div className="aq-table-wrap">
          <table className="aq-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.key || c.label} scope="col" className={`aq-th-${c.key}`}>
                    {c.sortable ? (
                      <button
                        type="button"
                        className={`aq-sort${sort.key === c.key ? ' on' : ''}`}
                        onClick={() => toggleSort(c.key)}
                        aria-label={`Sort by ${c.label}`}
                      >
                        {c.label}
                        <ChevronsUpDown size={12} aria-hidden="true" />
                      </button>
                    ) : c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const k = keyOf(o);
                const sev = SEVERITY[o.severity] || SEVERITY.medium;
                const Icon = KIND_ICONS[o.kind] || ClipboardCheck;
                const chip = deadlineChip(o.clock);
                const cite = citation(o.authority);
                const expanded = openRow === k;
                return (
                  <React.Fragment key={k}>
                    <tr className={`aq-row ${sev.tone}${expanded ? ' open' : ''}`}>
                      <td><span className={`aq-sev ${sev.tone}`}>{sev.label}</span></td>
                      <td>
                        <Link to={`/investigation-diary/${o.caseMasterId}`} className="aq-case">
                          {o.crimeNo} <ExternalLink size={11} aria-hidden="true" />
                        </Link>
                      </td>
                      <td className="aq-td-title">{o.title}</td>
                      <td>
                        <span className="aq-kind"><Icon size={11} aria-hidden="true" /> {KIND_LABEL[o.kind] || o.kind}</span>
                      </td>
                      <td>
                        {o.ioName ? (
                          <span className="aq-who">
                            <span className={`aq-avatar ${avatarTone(o.ioName)}`}>{initials(o.ioName)}</span>
                            <span className="aq-who-name">{o.ioName}</span>
                          </span>
                        ) : <span className="aq-muted">Unassigned</span>}
                      </td>
                      <td>
                        <span className={`aq-chip ${chip.tone}`}>
                          {chip.tone !== 'none' && <CalendarClock size={11} aria-hidden="true" />}
                          {chip.text}
                        </span>
                      </td>
                      <td className="aq-td-actions">
                        <button
                          type="button"
                          className="aq-details"
                          aria-expanded={expanded}
                          onClick={() => { setOpenRow(expanded ? null : k); setAcking(null); }}
                        >
                          Details
                          <ChevronDown size={12} className={expanded ? 'open' : ''} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>

                    {/* The prose the table cannot hold, one row at a time. The
                        finding is a claim about the file, the consequence is
                        what the law does about it, and the action is what to
                        do — that ordering is the whole argument for the row
                        existing, so it survives the layout change intact. */}
                    {expanded && (
                      <tr className={`aq-detail ${sev.tone}`}>
                        <td colSpan={COLUMNS.length}>
                          <div className="aq-detail-body">
                            <div className="aq-detail-prose">
                              <p className="aq-finding">{o.finding}</p>
                              <p className="aq-consequence">{o.consequence}</p>
                              <p className="aq-next"><strong>Next:</strong> {o.action}</p>
                            </div>
                            <div className="aq-detail-side">
                              {cite && (
                                <span className="aq-cite" title={o.authority?.title || ''}>
                                  <Scale size={11} aria-hidden="true" /> {cite}
                                  {o.authority?.verified === false && <em>unverified</em>}
                                </span>
                              )}
                              {o.basis && <span className={`aq-basis ${o.certain ? '' : 'soft'}`}>{o.basis}</span>}
                              {countdown(o.clock) && (
                                <span className={`aq-basis ${countdown(o.clock).over ? 'soft' : ''}`}>
                                  {countdown(o.clock).text}
                                </span>
                              )}

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
                                      <Check size={13} aria-hidden="true" /> Mark done
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
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open.length === 0 && data && scope !== 'command' && (
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
      {done.length > 0 && scope !== 'command' && (
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
