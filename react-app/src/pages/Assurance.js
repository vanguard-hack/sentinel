// Assurance console — the page that proves the safeguards are running.
//
// Sentinel's controls are its real differentiator and, until this page, every
// one of them was invisible. Grounding, clearance, audit tamper-evidence and
// export screening all work silently: an officer who never triggers them has
// no way to know they exist, and a supervisor signing off on the system has
// nothing to look at but a claim.
//
// This is the page that replaces the claim with a demonstration. It does not
// describe the controls — it attacks them, in this deployment, right now, and
// shows what happened. Every row names the attack, what should happen, and
// what the system actually did.
//
// Two deliberate choices:
//
//   • Failures are shown, not hidden. A console that can only report success
//     is decoration. If a control breaks, this page turns red and says which.
//   • Each control is also attacked in the FALSE-ALARM direction — a benign
//     document that must not be held, an honest answer that must not be
//     flagged. A control that cries wolf gets switched off within a week, so
//     both directions are proven here.
import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, FileLock2, Fingerprint,
  Loader2, RefreshCw, ShieldCheck, XCircle,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import { logAudit } from '../utils/audit';

const CONTROL_ICONS = {
  'audit-integrity': Fingerprint,
  grounding: ShieldCheck,
  clearance: FileLock2,
  'export-control': FileLock2,
};

const fmtTime = (ts) =>
  ts ? new Date(ts).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) : '—';

export default function Assurance() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(() => new Set(['audit-integrity']));

  const run = useCallback(async () => {
    setRunning(true);
    setError('');
    try {
      const res = await fetch('/server/rag/assurance/selftest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setData(body);
      logAudit('run-selftest', 'Assurance', `${body.report.summary.passed}/${body.report.summary.checks} passed`);
    } catch (e) {
      setError(e?.message || 'The self-test could not be run.');
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => { run(); }, [run]);

  const toggle = (id) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const report = data?.report;
  const posture = data?.posture;
  const s = report?.summary;

  return (
    <div className="page">
      <TopBar title="Assurance" subtitle="Proof that the safeguards are running in this deployment" />

      <div className="asr-intro">
        <ShieldCheck size={15} />
        <p>
          Passing tests in CI does not prove a control is alive in production — a safeguard can pass
          every unit test and be writing to a table that does not exist. This page takes the controls
          Sentinel actually depends on and <strong>attacks them here, now</strong>: it edits the audit
          log, invents a case number, asks for a victim&rsquo;s name without clearance, and walks a
          protected report out as a PDF. Each row shows what was attempted and what the system did.
        </p>
      </div>

      {/* ── Verdict banner ─────────────────────────────────────────────── */}
      {s && (
        <div className={`asr-verdict ${s.pass ? 'ok' : 'bad'}`}>
          <span className="asr-verdict-icon">
            {s.pass ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />}
          </span>
          <div>
            <h2>
              {s.pass
                ? 'All controls operational'
                : `${s.failed} check${s.failed === 1 ? '' : 's'} failed`}
            </h2>
            <p>
              {s.passed} of {s.checks} checks passed across {s.controls} controls · run {fmtTime(report.ranAt)}
            </p>
          </div>
          <button type="button" className="asr-rerun" onClick={run} disabled={running}>
            {running ? <Loader2 size={13} className="asr-spin" /> : <RefreshCw size={13} />}
            {running ? 'Running…' : 'Run again'}
          </button>
        </div>
      )}

      {error && <div className="asr-error"><AlertTriangle size={15} /> {error}</div>}
      {!data && !error && <div className="asr-empty"><Loader2 size={18} className="asr-spin" /> Running the control self-test…</div>}

      {/* ── Live posture ───────────────────────────────────────────────── */}
      {/* The self-test proves the controls behave. This proves they are wired
          to real state — a control can pass every check and still be attached
          to nothing. */}
      {posture && (
        <div className="asr-posture">
          <div className="asr-posture-card">
            <span className="asr-posture-label">Audit chain head</span>
            {posture.auditChain?.headHash ? (
              <>
                <code className="asr-hash">{posture.auditChain.headHash}</code>
                <span className="asr-posture-note">
                  Sealed through {posture.auditChain.day}. Copy this hash off-platform — a hash held
                  elsewhere is what makes the log evidence against someone who can rewrite the store.
                </span>
              </>
            ) : (
              <span className="asr-posture-note">
                {posture.auditChain?.note || 'Could not read the chain head.'}
              </span>
            )}
          </div>
          <div className="asr-posture-card">
            <span className="asr-posture-label">Export queue</span>
            {posture.exportQueue ? (
              <>
                <span className="asr-posture-figures">
                  <b>{posture.exportQueue.pending}</b> awaiting ·{' '}
                  <b>{posture.exportQueue.approved}</b> approved ·{' '}
                  <b>{posture.exportQueue.rejected}</b> refused
                </span>
                <span className="asr-posture-note">
                  Reports held for a second signature. Nobody can release their own request.
                </span>
              </>
            ) : (
              <span className="asr-posture-note">Could not read the export queue.</span>
            )}
          </div>
          {posture.errors?.length > 0 && (
            <div className="asr-posture-card warn">
              <span className="asr-posture-label">Live state unreadable</span>
              <span className="asr-posture-note">
                {posture.errors.join(' · ')} — the self-test above is unaffected; it depends on
                nothing external by design.
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Controls ───────────────────────────────────────────────────── */}
      <div className="asr-list">
        {(report?.controls || []).map((c) => {
          const Icon = CONTROL_ICONS[c.id] || ShieldCheck;
          const isOpen = open.has(c.id);
          return (
            <section key={c.id} className={`asr-control ${c.pass ? 'ok' : 'bad'}`}>
              <button type="button" className="asr-control-head" onClick={() => toggle(c.id)} aria-expanded={isOpen}>
                <span className="asr-control-icon"><Icon size={15} /></span>
                <div className="asr-control-title">
                  <h3>{c.name}</h3>
                  <p>{c.what}</p>
                  <code>{c.module}</code>
                </div>
                <span className={`asr-badge ${c.pass ? 'ok' : 'bad'}`}>
                  {c.pass ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                  {c.passed}/{c.checks.length}
                </span>
                <ChevronDown size={15} className={`asr-chev ${isOpen ? 'open' : ''}`} />
              </button>

              {c.error && (
                <p className="asr-control-error">
                  <AlertTriangle size={13} /> This control threw an error and could not be verified: {c.error}
                </p>
              )}

              {isOpen && c.checks.length > 0 && (
                <div className="asr-checks">
                  {c.checks.map((k, i) => (
                    <div key={`${c.id}-${i}`} className={`asr-check ${k.pass ? 'ok' : 'bad'}`}>
                      <span className="asr-check-mark">
                        {k.pass ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                      </span>
                      <div className="asr-check-body">
                        <h4>{k.name}</h4>
                        <dl>
                          <div><dt>Attack</dt><dd>{k.attack}</dd></div>
                          <div><dt>Expected</dt><dd>{k.expected}</dd></div>
                          <div className={k.pass ? '' : 'bad'}><dt>Observed</dt><dd>{k.observed}</dd></div>
                        </dl>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {report && (
        <p className="asr-foot">
          These checks call the same modules that serve live officers — not copies, not recorded
          results. If a control were removed, this page would turn red rather than keep reporting
          green. It complements the {report.summary.controls} test suites that run on every push; what
          it adds is the question CI cannot answer — whether the controls are alive in <em>this</em>{' '}
          deployment.
        </p>
      )}
    </div>
  );
}
