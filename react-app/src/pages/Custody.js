import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2, RefreshCw, AlertTriangle, Search, ChevronLeft, ChevronRight,
  CalendarClock, Gavel, UserX, Users, ScrollText,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import { Donut, HBarList } from '../components/Charts';
import { useAccess } from '../context/AccessContext';
import {
  getRegistry, seedCustody, STATUS, STATUS_ORDER, fmtDate,
  allSections, allFacilities,
} from '../utils/custody';
import { Database } from 'lucide-react';

const PER_PAGE = 12;
const RELEASE_WINDOWS = [
  ['any', 'Any release window'], ['30', 'Releasing ≤ 30 days'],
  ['90', 'Releasing ≤ 90 days'], ['365', 'Releasing ≤ 1 year'],
];

const Chip = ({ status }) => <span className={`cust-chip ${STATUS[status]?.cls || ''}`}>{status}</span>;

function Initials({ name }) {
  const t = (name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return <span className="cust-ava" aria-hidden="true">{t}</span>;
}

function Kpi({ value, label, tone }) {
  return (
    <div className={`cust-kpi ${tone || ''}`}>
      <span className="cust-kpi-val">{value}</span>
      <span className="cust-kpi-lab">{label}</span>
    </div>
  );
}

export default function Custody() {
  const navigate = useNavigate();
  const { isAdmin } = useAccess();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('registry');
  const [seeding, setSeeding] = useState(null); // { done, total } | null

  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState('All');
  const [fFacility, setFFacility] = useState('All');
  const [fSection, setFSection] = useState('All');
  const [fRelease, setFRelease] = useState('any');
  const [page, setPage] = useState(1);

  const load = useCallback(async (force) => {
    setLoading(true); setError(null);
    try { setData(await getRegistry(force)); }
    catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const runSeed = useCallback(async () => {
    setSeeding({ done: 0, total: data?.analytics.total || 0 });
    try {
      await seedCustody((done, total) => setSeeding({ done, total }));
      await load(true);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSeeding(null);
    }
  }, [data, load]);

  const people = useMemo(() => data?.people || [], [data]);
  const sections = useMemo(() => allSections(people), [people]);
  const facilities = useMemo(() => allFacilities(people), [people]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const relDays = fRelease === 'any' ? null : Number(fRelease);
    return people.filter((p) => {
      if (fStatus !== 'All' && p.status !== fStatus) return false;
      if (fFacility !== 'All' && p.facility !== fFacility) return false;
      if (fSection !== 'All' && !p.sections.some((s) => s.code === fSection)) return false;
      if (relDays != null) {
        const rel = p.sentence?.expectedRelease;
        if (!rel || rel < data.now || rel > data.now + relDays * 86400000) return false;
      }
      if (needle) {
        const hay = `${p.name} ${p.aliases.join(' ')} ${p.biometricId} ${p.cases.map((c) => c.crimeNo).join(' ')} ${p.sections.map((s) => s.code).join(' ')}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [people, q, fStatus, fFacility, fSection, fRelease, data]);

  useEffect(() => { setPage(1); }, [q, fStatus, fFacility, fSection, fRelease]);
  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const rows = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  if (loading) return (<div className="cf-page"><TopBar title="Custody & Corrections" /><div className="cf-state"><div className="cf-spinner" /><p>Loading custodial records…</p></div></div>);
  if (error) return (<div className="cf-page"><TopBar title="Custody & Corrections" /><div className="cf-state cf-error"><AlertTriangle size={22} /><p>{error}</p><button className="cf-retry" onClick={load}>Retry</button></div></div>);

  const a = data.analytics;

  return (
    <div className="cf-page">
      <TopBar title="Custody & Corrections">
        {isAdmin && data.tableReady && data.persistedCount < a.total && (
          <button className="aa-btn" onClick={runSeed} disabled={!!seeding} title="Write the registry to the Data Store">
            <Database size={14} /> {seeding ? `Persisting ${seeding.done}/${seeding.total}…` : `Persist to Data Store`}
          </button>
        )}
        <button className="cf-icon-btn" onClick={() => load(true)} title="Refresh"><RefreshCw size={15} /></button>
      </TopBar>
      <div className="pp-body">
        <div className="cust-head">
          <div className="cust-title">
            <Building2 size={20} strokeWidth={1.9} />
            <div>
              <h1>Custody &amp; Corrections</h1>
              <p>Custodial registry of undertrials and convicts — status, custody, bail, sentence and post-release, drawn from case records (correctional details are indicative).</p>
            </div>
          </div>
        </div>

        <div className="cust-kpi-row">
          <Kpi value={a.total.toLocaleString()} label="Persons on record" />
          <Kpi value={a.undertrials.toLocaleString()} label="Undertrials" tone="t-under" />
          <Kpi value={a.convicts.toLocaleString()} label="Convicted" tone="t-conv" />
          <Kpi value={people.filter((p) => p.status === 'On bail').length} label="On bail" tone="t-bail" />
          <Kpi value={people.filter((p) => p.status === 'Absconding').length} label="Absconding" tone="t-absc" />
          <Kpi value={`${a.avgCustodyDays} d`} label="Avg. custody" />
        </div>

        <div className="seg-group cust-tabs" role="tablist">
          {[['registry', 'Registry', ScrollText], ['alerts', 'Alerts', CalendarClock], ['analytics', 'Analytics', Users]].map(([k, lbl, Icon]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`seg-btn ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
              <Icon size={14} /> {lbl}
              {k === 'alerts' && (data.alerts.releases.length + data.alerts.hearings.length + data.alerts.missed.length) > 0 &&
                <span className="cust-badge">{data.alerts.releases.length + data.alerts.hearings.length + data.alerts.missed.length}</span>}
            </button>
          ))}
        </div>

        {tab === 'registry' && (
          <>
            <div className="cust-filters">
              <div className="cf-search">
                <Search size={15} className="cf-search-icon" />
                <input className="cf-search-input" placeholder="Search name, alias, FIR, biometric ID, section…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <select className="cf-select" value={fStatus} onChange={(e) => setFStatus(e.target.value)} title="Status">
                <option value="All">All statuses</option>
                {STATUS_ORDER.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select className="cf-select" value={fFacility} onChange={(e) => setFFacility(e.target.value)} title="Facility">
                <option value="All">All facilities</option>
                {facilities.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <select className="cf-select" value={fSection} onChange={(e) => setFSection(e.target.value)} title="Section">
                <option value="All">All sections</option>
                {sections.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select className="cf-select" value={fRelease} onChange={(e) => setFRelease(e.target.value)} title="Release window">
                {RELEASE_WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <span className="cust-count">{filtered.length.toLocaleString()} of {people.length.toLocaleString()}</span>
            </div>

            <div className="cf-scroll">
              <table className="fc-table cust-table">
                <thead>
                  <tr>
                    <th>Person</th><th>Status</th><th>Facility</th><th>Sections</th>
                    <th>Cases</th><th>Custody</th><th>Next hearing</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.personId} className="cust-row" onClick={() => navigate(`/custody/${p.personId}`)}>
                      <td>
                        <div className="cust-person">
                          <Initials name={p.name} />
                          <div>
                            <span className="cust-person-name">{p.name}{p.recidivism.repeatOffender && <span className="cust-repeat" title="Repeat offender">↺</span>}</span>
                            <span className="cust-person-sub">{p.biometricId}{p.aliases.length ? ` · alias ${p.aliases[0]}` : ''}</span>
                          </div>
                        </div>
                      </td>
                      <td><Chip status={p.status} /></td>
                      <td className="cust-fac">{p.facility || '—'}</td>
                      <td className="cust-secs">{p.sections.slice(0, 2).map((s) => <span key={s.code} className="cust-sec">{s.code}</span>)}{p.sections.length > 2 && <span className="cust-sec more">+{p.sections.length - 2}</span>}</td>
                      <td>{p.cases.length}</td>
                      <td className="cust-num">{p.custodyDays != null ? `${p.custodyDays} d` : '—'}</td>
                      <td className="cust-num">{p.nextHearing ? fmtDate(p.nextHearing) : '—'}</td>
                    </tr>
                  ))}
                  {!rows.length && <tr><td colSpan={7} className="rp-empty">No records match these filters.</td></tr>}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="inv-pagination">
                <button className="inv-page-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous"><ChevronLeft size={16} /></button>
                <span className="inv-page-info">Page {page} of {pages}</span>
                <button className="inv-page-btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next"><ChevronRight size={16} /></button>
              </div>
            )}
          </>
        )}

        {tab === 'alerts' && (
          <div className="cust-alerts">
            <AlertList
              icon={<CalendarClock size={16} />} title="Upcoming releases" sub="Convicts with an expected release date within 90 days"
              items={data.alerts.releases} render={(x) => <><b>{x.name}</b><span>{x.facility}</span></>} right={(x) => fmtDate(x.date)} onGo={(x) => navigate(`/custody/${x.id}`)} empty="No releases due in the next 90 days." />
            <AlertList
              icon={<Gavel size={16} />} title="Bail hearings" sub="Undertrials with a bail hearing within 30 days"
              items={data.alerts.hearings} render={(x) => <><b>{x.name}</b><span>{x.court}</span></>} right={(x) => fmtDate(x.date)} onGo={(x) => navigate(`/custody/${x.id}`)} empty="No bail hearings scheduled in the next 30 days." />
            <AlertList
              icon={<UserX size={16} />} title="Missed reporting" sub="Released / on-bail persons who have missed a reporting obligation"
              items={data.alerts.missed} render={(x) => <><b>{x.name}</b><span>{x.obligation}</span></>} right={(x) => <Chip status={x.status} />} onGo={(x) => navigate(`/custody/${x.id}`)} empty="No missed reporting flagged." />
          </div>
        )}

        {tab === 'analytics' && (
          <div className="rp-grid">
            <section className="rp-card">
              <div className="rp-card-head"><h2>Custody status</h2><span className="rp-card-sub">Distribution across the registry</span></div>
              <div className="rp-card-body"><Donut data={a.statusCounts.filter((d) => d.value)} /></div>
            </section>
            <section className="rp-card cust-ratio-card">
              <div className="rp-card-head"><h2>Undertrial : convict ratio</h2><span className="rp-card-sub">Persons awaiting trial vs. convicted</span></div>
              <div className="rp-card-body cust-ratio">
                <div><span className="cust-ratio-big">{a.ratio.toFixed(2)}</span><span className="cust-ratio-lab">undertrials per convict</span></div>
                <div className="cust-ratio-split"><span className="t-under">{a.undertrials} undertrial</span><span className="t-conv">{a.convicts} convicted</span></div>
                <p className="cust-ratio-note">Average time in custody: <b>{a.avgCustodyDays} days</b> across {a.undertrials + a.convicts} persons currently held.</p>
              </div>
            </section>
            <section className="rp-card rp-card-wide">
              <div className="rp-card-head"><h2>Overcrowding by facility</h2><span className="rp-card-sub">Occupancy against sanctioned capacity — bars past 100% are over capacity</span></div>
              <div className="rp-card-body">
                <div className="cust-fac-list">
                  {a.facilities.map((f) => (
                    <div key={f.facility} className="cust-fac-row">
                      <div className="cust-fac-name">{f.facility}</div>
                      <div className="cust-fac-bar"><div className={`cust-fac-fill ${f.pct > 100 ? 'over' : ''}`} style={{ width: `${Math.min(100, f.pct)}%` }} /></div>
                      <div className={`cust-fac-pct ${f.pct > 100 ? 'over' : ''}`}>{f.pct}%</div>
                      <div className="cust-fac-cap">{f.occupancy}/{f.capacity}</div>
                    </div>
                  ))}
                  {!a.facilities.length && <div className="rp-empty">No occupied facilities.</div>}
                </div>
              </div>
            </section>
            <section className="rp-card rp-card-wide">
              <div className="rp-card-head"><h2>Custodial population by facility</h2><span className="rp-card-sub">Persons currently held per facility</span></div>
              <div className="rp-card-body"><HBarList data={a.facilities.map((f) => ({ label: f.facility.replace(/,.*/, ''), value: f.occupancy }))} /></div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function AlertList({ icon, title, sub, items, render, right, onGo, empty }) {
  return (
    <section className="rp-card cust-alert-card">
      <div className="rp-card-head"><h2>{icon} {title} <span className="cust-alert-n">{items.length}</span></h2><span className="rp-card-sub">{sub}</span></div>
      <div className="rp-card-body">
        {items.length ? (
          <ul className="cust-alert-list">
            {items.map((x) => (
              <li key={x.id} onClick={() => onGo(x)}>
                <div className="cust-alert-main">{render(x)}</div>
                <div className="cust-alert-right">{right(x)}</div>
              </li>
            ))}
          </ul>
        ) : <div className="rp-empty">{empty}</div>}
      </div>
    </section>
  );
}
