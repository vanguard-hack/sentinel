import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Shield, RefreshCw, AlertTriangle, ChevronDown, Flame,
  MapPin, Clock, User, Users, Gavel, Phone, BadgeCheck, FileText, Search,
} from 'lucide-react';
import { fetchIncidents } from '../utils/incidents';
import TopBar from '../components/TopBar';

const STATUS_TONE = {
  'Under Investigation': 'amber', 'Charge Sheeted': 'blue', 'Pending Trial': 'blue',
  Convicted: 'green', Acquitted: 'green', 'Closed - False Case': 'grey', 'Closed - Undetected': 'grey',
};

const fmtDateTime = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—');

function Detail({ Icon, label, children }) {
  return (
    <div className="inc-detail">
      <div className="inc-detail-h"><Icon size={14} /> {label}</div>
      <div className="inc-detail-b">{children}</div>
    </div>
  );
}

function IncidentRow({ inc, open, onToggle }) {
  return (
    <div className={`inc-card ${open ? 'open' : ''}`}>
      <button className="inc-head" onClick={onToggle}>
        <div className="inc-head-main">
          <span className="inc-crimeno">{inc.crimeNo}</span>
          {inc.heinous && <span className="db-badge-heinous" title="Heinous"><Flame size={12} /></span>}
          <span className="inc-type">{inc.crimeType}</span>
        </div>
        <div className="inc-head-meta">
          <span className="inc-where">{inc.station}, {inc.district}</span>
          <span className="inc-date">{String(inc.registeredDate).slice(0, 10)}</span>
          <span className={`db-status db-status-${STATUS_TONE[inc.status] || 'grey'}`}>{inc.status}</span>
          <ChevronDown size={17} className="inc-chevron" />
        </div>
      </button>

      {open && (
        <div className="inc-body">
          <p className="inc-facts">{inc.briefFacts || 'No summary recorded.'}</p>

          <div className="inc-grid">
            <Detail Icon={Clock} label="Timeline">
              <div><b>Registered:</b> {fmtDateTime(inc.registeredDate)}</div>
              <div><b>Incident:</b> {fmtDateTime(inc.incidentFrom)} → {fmtDateTime(inc.incidentTo)}</div>
              <div><b>Info received:</b> {fmtDateTime(inc.infoReceived)}</div>
            </Detail>

            <Detail Icon={MapPin} label="Location">
              <div>{inc.station}</div>
              <div>{inc.district} district</div>
              {inc.lat && inc.lng && (
                <a
                  className="inc-maplink"
                  href={`https://www.google.com/maps?q=${inc.lat},${inc.lng}`}
                  target="_blank" rel="noreferrer"
                >
                  {Number(inc.lat).toFixed(4)}, {Number(inc.lng).toFixed(4)} ↗
                </a>
              )}
            </Detail>

            <Detail Icon={BadgeCheck} label="Classification">
              <div><b>Category:</b> {inc.category}</div>
              <div><b>Head:</b> {inc.crimeHead}</div>
              <div><b>Gravity:</b> {inc.gravity}</div>
              <div><b>Court:</b> {inc.court}</div>
            </Detail>

            <Detail Icon={Shield} label="Assigned officer">
              {inc.officer ? (
                <>
                  <div><b>{inc.officer.rank} {inc.officer.name}</b></div>
                  <div>{inc.officer.designation}</div>
                  <div>KGID: {inc.officer.kgid}</div>
                  <div className="inc-phone"><Phone size={12} /> {inc.officer.phone}</div>
                  <div>{inc.officer.station}</div>
                </>
              ) : '—'}
            </Detail>

            <Detail Icon={User} label={`Complainant${inc.complainants.length > 1 ? 's' : ''}`}>
              {inc.complainants.length ? inc.complainants.map((c, i) => (
                <div key={i}>{c.name} · {c.age}/{c.gender[0]} · {c.occupation}{c.religion ? ` · ${c.religion}` : ''}</div>
              )) : '—'}
            </Detail>

            <Detail Icon={Users} label={`Victim${inc.victims.length > 1 ? 's' : ''}`}>
              {inc.victims.length ? inc.victims.map((v, i) => (
                <div key={i}>{v.name} · {v.age}/{v.gender[0]}{v.isPolice ? ' · Police' : ''}</div>
              )) : 'None recorded'}
            </Detail>

            <Detail Icon={Users} label={`Accused (${inc.accused.length})`}>
              {inc.accused.length ? inc.accused.map((a, i) => (
                <div key={i}>{a.tag}: {a.name} · {a.age}/{a.gender[0]}</div>
              )) : 'None named'}
            </Detail>

            <Detail Icon={Gavel} label="Acts & sections">
              {inc.sections.length ? inc.sections.map((s, i) => (
                <div key={i} title={s.desc}><b>{s.act}</b> §{s.section}{s.desc ? ` — ${s.desc}` : ''}</div>
              )) : '—'}
            </Detail>

            {inc.arrests.length > 0 && (
              <Detail Icon={BadgeCheck} label="Arrests / surrenders">
                {inc.arrests.map((a, i) => (
                  <div key={i}>{a.type} on {String(a.date).slice(0, 10)}{a.io ? ` · by ${a.io.rank} ${a.io.name}` : ''}</div>
                ))}
              </Detail>
            )}

            {inc.chargesheet && (
              <Detail Icon={FileText} label="Chargesheet">
                <div>Filed {fmtDateTime(inc.chargesheet.csdate)}</div>
                <div>Type: {({ A: 'Chargesheet', B: 'False Case', C: 'Undetected' })[inc.chargesheet.cstype] || inc.chargesheet.cstype}</div>
              </Detail>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Incidents() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('ALL');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await fetchIncidents(40)); }
    catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const statuses = useMemo(
    () => ['ALL', ...Array.from(new Set((data || []).map((d) => d.status)))],
    [data]
  );
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data || []).filter((d) => {
      if (status !== 'ALL' && d.status !== status) return false;
      if (!needle) return true;
      return [d.crimeNo, d.crimeType, d.station, d.district, d.crimeHead,
        ...d.complainants.map((c) => c.name), ...d.accused.map((a) => a.name)]
        .join(' ').toLowerCase().includes(needle);
    });
  }, [data, q, status]);

  return (
    <div className="rp-page">
      <TopBar title="Incidents" subtitle="Latest FIRs & case status">
        <button className="cf-icon-btn" onClick={load} title="Refresh" disabled={loading}>
          <RefreshCw size={15} className={loading ? 'cf-spin' : ''} />
        </button>
      </TopBar>

      <main className="rp-main">
        <div className="inc-toolbar">
          <div className="cf-search">
            <Search size={14} className="cf-search-icon" />
            <input className="cf-search-input" placeholder="Search crime no, type, station, name…"
              value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="cf-select" value={status} onChange={(e) => setStatus(e.target.value)}>
            {statuses.map((s) => <option key={s} value={s}>{s === 'ALL' ? 'All statuses' : s}</option>)}
          </select>
          {data && <span className="inc-count">{shown.length} of {data.length} latest FIRs</span>}
        </div>

        {error ? (
          <div className="cf-state cf-error"><AlertTriangle size={22} /><p>{error}</p>
            <button className="cf-retry" onClick={load}>Retry</button></div>
        ) : loading || !data ? (
          <div className="cf-state"><div className="cf-spinner" /><p>Loading latest FIRs…</p></div>
        ) : shown.length === 0 ? (
          <div className="cf-state"><FileText size={22} /><p>No matching incidents.</p></div>
        ) : (
          <div className="inc-list">
            {shown.map((inc) => (
              <IncidentRow key={inc.id} inc={inc} open={openId === inc.id}
                onToggle={() => setOpenId(openId === inc.id ? null : inc.id)} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
