import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, MapPin, CalendarClock, Gavel, Scale,
  Clock, ShieldAlert, RotateCcw, FileText, Landmark, Pencil, Check, X,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import { useAccess } from '../context/AccessContext';
import { getRegistry, saveCustodyRecord, STATUS_ORDER, STATUS, fmtDate } from '../utils/custody';

const Chip = ({ status }) => <span className={`cust-chip ${STATUS[status]?.cls || ''}`}>{status}</span>;

function Section({ icon, title, children, sub }) {
  return (
    <section className="rp-card rp-card-wide cust-sec-card">
      <div className="rp-card-head"><h2>{icon} {title}</h2>{sub && <span className="rp-card-sub">{sub}</span>}</div>
      <div className="rp-card-body">{children}</div>
    </section>
  );
}

const Field = ({ k, v }) => (<div className="cust-field"><span>{k}</span><b>{v || '—'}</b></div>);

export default function CustodyRecord() {
  const { personId } = useParams();
  const navigate = useNavigate();
  const { isAdmin, role } = useAccess();
  const canEdit = isAdmin || role === 'supervisor' || role === 'investigator';
  const [p, setP] = useState(undefined); // undefined = loading, null = not found
  const [error, setError] = useState(null);
  const [edit, setEdit] = useState(null); // { status, facility } | null
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getRegistry()
      .then((reg) => setP(reg.byId.get(personId) || null))
      .catch((e) => setError(e.message || String(e)));
  }, [personId]);

  const saveEdit = async () => {
    setSaving(true);
    const updated = { ...p, status: edit.status, facility: edit.facility || null };
    try {
      await saveCustodyRecord(updated);
      setP(updated);
      setEdit(null);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  if (error) return (<div className="cf-page"><TopBar title="Custodial record" parent="Inmate Registry" parentTo="/custody" /><div className="cf-state cf-error"><AlertTriangle size={22} /><p>{error}</p></div></div>);
  if (p === undefined) return (<div className="cf-page"><TopBar title="Custodial record" parent="Inmate Registry" parentTo="/custody" /><div className="cf-state"><div className="cf-spinner" /><p>Loading record…</p></div></div>);
  if (p === null) return (<div className="cf-page"><TopBar title="Custodial record" parent="Inmate Registry" parentTo="/custody" /><div className="cf-state"><p>Record not found.</p><button className="cf-retry" onClick={() => navigate('/custody')}>Back to registry</button></div></div>);

  const initials = p.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="cf-page">
      <TopBar title={p.name} parent="Inmate Registry" parentTo="/custody" />
      <div className="pp-body">
        {/* Identity header */}
        <section className="rp-card rp-card-wide cust-idcard">
          <span className="cust-ava lg">{initials}</span>
          <div className="cust-id-main">
            <div className="cust-id-top">
              <h1>{p.name}</h1>
              {edit ? (
                <select className="cf-select cust-edit-sel" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                  {STATUS_ORDER.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : <Chip status={p.status} />}
              {p.recidivism.repeatOffender && <span className="cust-flag"><RotateCcw size={12} /> Repeat offender</span>}
              <div className="cust-id-actions">
                {edit ? (
                  <>
                    <button className="aa-btn primary" onClick={saveEdit} disabled={saving}><Check size={14} /> {saving ? 'Saving…' : 'Save'}</button>
                    <button className="aa-btn" onClick={() => setEdit(null)} disabled={saving}><X size={14} /> Cancel</button>
                  </>
                ) : canEdit && (
                  <button className="aa-btn" onClick={() => setEdit({ status: p.status, facility: p.facility || '' })}><Pencil size={13} /> Edit</button>
                )}
              </div>
            </div>
            {p.aliases.length > 0 && <div className="cust-id-alias">alias: {p.aliases.join(', ')}</div>}
            <div className="cust-id-grid">
              <Field k="Biometric ID" v={p.biometricId} />
              <Field k="Date of birth" v={`${fmtDate(p.dob)} (${p.age} yrs)`} />
              <Field k="Gender" v={p.gender} />
              {edit ? (
                <div className="cust-field"><span>Facility</span>
                  <input className="cf-search-input cust-edit-inp" value={edit.facility} placeholder="Facility (blank if not in custody)" onChange={(e) => setEdit({ ...edit, facility: e.target.value })} />
                </div>
              ) : <Field k="Facility" v={p.facility} />}
              <Field k="Address" v={p.address} />
              <Field k="Custody duration" v={p.custodyDays != null ? `${p.custodyDays} days` : '—'} />
            </div>
          </div>
        </section>

        {/* Case linkage */}
        <Section icon={<FileText size={16} />} title="Case linkage" sub="Charges, court and trial stage for each linked case">
          {p.trialStage && (
            <div className="cust-trial">
              <span><Scale size={13} /> Trial stage: <b>{p.trialStage}</b></span>
              {p.nextHearing && <span><CalendarClock size={13} /> Next hearing: <b>{fmtDate(p.nextHearing)}</b></span>}
              <span><Landmark size={13} /> {p.court}</span>
            </div>
          )}
          <div className="cf-scroll">
            <table className="fc-table">
              <thead><tr><th>FIR / Case</th><th>Date</th><th>Offence</th><th>Sections (BNS)</th><th>Station / District</th><th>Status</th></tr></thead>
              <tbody>
                {p.cases.map((c) => (
                  <tr key={c.id}>
                    <td className="fc-pid">{c.crimeNo}</td>
                    <td>{fmtDate(c.date)}</td>
                    <td>{c.subHead}{c.heinous && <span className="cust-heinous" title="Heinous">●</span>}<div className="cust-head-sub">{c.head}</div></td>
                    <td className="cust-secs">{c.sections.map((s) => <span key={s.code} className="cust-sec" title={s.desc}>{s.code}</span>)}</td>
                    <td>{c.station}<div className="cust-head-sub">{c.district}</div></td>
                    <td>{c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* Sentence details */}
        {p.sentence && (
          <Section icon={<Gavel size={16} />} title="Sentence details" sub="Conviction, term, remission and expected release">
            <div className="cust-id-grid">
              <Field k="Convicted on" v={fmtDate(p.sentence.convictionDate)} />
              <Field k="Sentence term" v={`${p.sentence.termMonths} months (${(p.sentence.termMonths / 12).toFixed(1)} yrs)`} />
              <Field k="Remission earned" v={`${p.sentence.remissionDays} days`} />
              <Field k="Expected release" v={fmtDate(p.sentence.expectedRelease)} />
            </div>
          </Section>
        )}

        {/* Custody timeline */}
        <Section icon={<Clock size={16} />} title="Custody timeline" sub="Arrest → remand → transfers → release, as an audit trail">
          <ol className="cust-timeline">
            {p.timeline.map((t, i) => (
              <li key={i} className={`cust-tl-${t.kind}`}>
                <span className="cust-tl-dot" />
                <span className="cust-tl-date">{fmtDate(t.ts)}</span>
                <span className="cust-tl-label">{t.label}</span>
              </li>
            ))}
          </ol>
        </Section>

        {/* Bail history */}
        <Section icon={<Scale size={16} />} title="Bail history" sub="Applications, outcomes, surety and conditions">
          {p.bail.nextBailHearing && <div className="cust-next-bail"><CalendarClock size={13} /> Next bail hearing: <b>{fmtDate(p.bail.nextBailHearing)}</b></div>}
          {p.bail.applications.length ? (
            <div className="cf-scroll">
              <table className="fc-table">
                <thead><tr><th>Applied</th><th>Court</th><th>Outcome</th><th>Surety</th><th>Conditions</th></tr></thead>
                <tbody>
                  {p.bail.applications.map((b, i) => (
                    <tr key={i}>
                      <td>{fmtDate(b.date)}</td>
                      <td>{b.court}</td>
                      <td><span className={`cust-bail ${b.outcome === 'Granted' ? 'ok' : 'no'}`}>{b.outcome}</span></td>
                      <td>{b.surety}</td>
                      <td className="cust-conds">{b.conditions.length ? b.conditions.map((c) => <span key={c} className="cust-cond">{c}</span>) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="rp-empty">No bail applications on record.</div>}
        </Section>

        {/* Release & post-release */}
        {p.release && (
          <Section icon={<MapPin size={16} />} title="Release & post-release" sub="Release, parole/furlough and reporting obligations">
            <div className="cust-id-grid">
              <Field k="Released on" v={p.release.releaseDate ? fmtDate(p.release.releaseDate) : '—'} />
              <Field k="Reporting obligation" v={p.release.obligation} />
              <Field k="Next report due" v={fmtDate(p.release.nextReport)} />
              <div className="cust-field"><span>Compliance</span><b>{p.release.missed ? <span className="cust-miss"><ShieldAlert size={12} /> Missed reporting</span> : <span className="cust-ok-txt">In compliance</span>}</b></div>
            </div>
            {p.release.parole.length > 0 && (
              <>
                <div className="cust-subhead">Parole / furlough</div>
                <div className="cf-scroll">
                  <table className="fc-table">
                    <thead><tr><th>Type</th><th>From</th><th>To</th><th>Reason</th></tr></thead>
                    <tbody>{p.release.parole.map((x, i) => (<tr key={i}><td>{x.type}</td><td>{fmtDate(x.from)}</td><td>{fmtDate(x.to)}</td><td>{x.reason}</td></tr>))}</tbody>
                  </table>
                </div>
              </>
            )}
          </Section>
        )}

        {/* Recidivism */}
        <Section icon={<RotateCcw size={16} />} title="Recidivism" sub="Prior convictions and repeat-offender assessment">
          <div className="cust-id-grid">
            <Field k="Linked cases" v={p.recidivism.caseCount} />
            <Field k="Prior convictions" v={p.recidivism.priorConvictions} />
            <div className="cust-field"><span>Repeat offender</span><b>{p.recidivism.repeatOffender ? <span className="cust-miss"><RotateCcw size={12} /> Flagged</span> : 'No'}</b></div>
            <Field k="Biometric ID" v={p.biometricId} />
          </div>
        </Section>
      </div>
    </div>
  );
}
