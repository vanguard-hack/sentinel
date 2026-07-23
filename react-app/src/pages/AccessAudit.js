import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  ShieldCheck, RefreshCw, Download, FileSpreadsheet, AlertTriangle, Check,
  Calendar, ChevronDown,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import DateRangeCalendar from '../components/DateRangeCalendar';
import { ROLE_LABELS, ASSIGNABLE_ROLES } from '../utils/access';
import { logAudit } from '../utils/audit';

// Close a popover when clicking outside its ref.
function useClickAway(ref, onAway) {
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onAway(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, onAway]);
}

// Single calendar-icon button → a month-grid range picker (click start, then
// end; the span highlights). No separate From/To fields.
function DateRangeButton({ from, to, onApply }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const ref = useRef(null);
  useClickAway(ref, () => setOpen(false));
  const openPop = () => { setF(from); setT(to); setOpen(true); };
  const apply = () => { if (f) onApply(f, t || f); setOpen(false); };
  return (
    <div className="aa-daterange" ref={ref}>
      <button type="button" className="aa-btn aa-cal-btn" onClick={() => (open ? setOpen(false) : openPop())} title="Select date range">
        <Calendar size={15} /> {from} → {to}
      </button>
      {open && (
        <div className="aa-daterange-pop" role="dialog" aria-label="Select date range">
          <DateRangeCalendar from={f} to={t} onSelect={(nf, nt) => { setF(nf); setT(nt); }} />
          <div className="aa-daterange-actions">
            <button type="button" className="aa-btn" onClick={() => { setF(''); setT(''); }}>Clear</button>
            <button type="button" className="aa-btn primary" onClick={apply} disabled={!f}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Single Export button → dropdown to pick CSV or XLSX.
function ExportMenu({ onCsv, onXlsx, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickAway(ref, () => setOpen(false));
  return (
    <div className="aa-export" ref={ref}>
      <button type="button" className="aa-btn primary" disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <Download size={14} /> Export <ChevronDown size={13} />
      </button>
      {open && (
        <div className="aa-export-menu">
          <button type="button" onClick={() => { onCsv(); setOpen(false); }}><Download size={13} /> CSV</button>
          <button type="button" onClick={() => { onXlsx(); setOpen(false); }}><FileSpreadsheet size={13} /> XLSX</button>
        </div>
      )}
    </div>
  );
}

// Admin console: assign app roles to users, and browse/export the audit
// trail (who opened what, from where, when — in IST).

const isoDay = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => isoDay(new Date(Date.now() - n * 86_400_000));

const AUDIT_COLUMNS = [
  ['istTime', 'Time (IST)'],
  ['name', 'Name'],
  ['email', 'Email'],
  ['role', 'Role'],
  ['feature', 'Feature'],
  ['action', 'Action'],
  ['path', 'Path'],
  ['detail', 'Detail'],
  ['ip', 'IP address'],
  ['location', 'Location'],
  ['device', 'Device'],
];

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function download(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function RolesTab() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [savedFlash, setSavedFlash] = useState({}); // email → true briefly

  useEffect(() => {
    post('/server/rag/access/users')
      .then((d) => setUsers(d.users || []))
      .catch((e) => setError(e.message));
  }, []);

  const save = async (email, role) => {
    setUsers((us) => us.map((u) => (u.email === email ? { ...u, role } : u)));
    try {
      await post('/server/rag/access/save', { email, role });
      setSavedFlash((f) => ({ ...f, [email]: true }));
      setTimeout(() => setSavedFlash((f) => ({ ...f, [email]: false })), 1800);
    } catch (e) {
      setError(`Could not save ${email}: ${e.message}`);
    }
  };

  if (error) {
    return <div className="aa-error"><AlertTriangle size={16} /> {error}</div>;
  }
  if (!users) return <div className="aa-loading">Loading users…</div>;

  return (
    <>
      <p className="aa-hint">
        Each user carries one role that decides which features open for them —
        Investigators get the case-level tools, Analysts the analytics views,
        Supervisors both plus personnel management, Policymakers the strategic
        views. Admin comes from the Catalyst project role and cannot be
        assigned here.
      </p>
      <div className="aa-table-wrap">
        <table className="aa-table">
          <thead>
            <tr><th>User</th><th>Status</th><th>Role</th><th /></tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isAdmin = /admin/i.test(u.catalystRole);
              return (
                <tr key={u.email}>
                  <td>
                    <div className="aa-user">
                      <span className="aa-user-name">{u.name || u.email}</span>
                      <span className="aa-user-email">{u.email}</span>
                    </div>
                  </td>
                  <td><span className="aa-chip">{u.status || '—'}</span></td>
                  <td>
                    {isAdmin ? (
                      <span className="aa-chip admin">Admin</span>
                    ) : (
                      <select
                        className="cf-select aa-select"
                        value={u.role}
                        onChange={(e) => save(u.email, e.target.value)}
                      >
                        {ASSIGNABLE_ROLES.filter((r) => r !== 'admin').map((r) => (
                          <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="aa-saved">{savedFlash[u.email] && <><Check size={14} /> Saved</>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AuditTab() {
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(daysAgo(0));
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fUser, setFUser] = useState('All');
  const [fFeature, setFFeature] = useState('All');
  const [fAction, setFAction] = useState('All');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await post('/server/rag/access/records', { from, to });
      setEvents(d.events || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const options = useMemo(() => {
    const uniq = (k) => ['All', ...[...new Set((events || []).map((e) => e[k]).filter(Boolean))].sort()];
    return { users: uniq('email'), features: uniq('feature'), actions: uniq('action') };
  }, [events]);

  const shown = useMemo(
    () => (events || []).filter(
      (e) =>
        (fUser === 'All' || e.email === fUser) &&
        (fFeature === 'All' || e.feature === fFeature) &&
        (fAction === 'All' || e.action === fAction)
    ),
    [events, fUser, fFeature, fAction]
  );

  const roleName = (e) => ROLE_LABELS[e.role] || e.role || '';

  const exportRows = () => [
    AUDIT_COLUMNS.map(([, label]) => label),
    ...shown.map((e) =>
      AUDIT_COLUMNS.map(([k]) => (k === 'role' ? roleName(e) : String(e[k] ?? '')))
    ),
  ];

  const exportCsv = () => {
    // ﻿ BOM so Excel opens the file as UTF-8.
    const csv = '﻿' + exportRows()
      .map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    download(
      `sentinel-audit-${from}-to-${to}.csv`,
      new Blob([csv], { type: 'text/csv;charset=utf-8' })
    );
    logAudit('export-csv', 'Access & Audit', `${shown.length} events`);
  };

  const exportXlsx = async () => {
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet(exportRows());
    ws['!cols'] = AUDIT_COLUMNS.map(([k]) => ({ wch: k === 'device' ? 40 : k === 'istTime' ? 24 : 18 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Audit log');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    download(
      `sentinel-audit-${from}-to-${to}.xlsx`,
      new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    );
    logAudit('export-xlsx', 'Access & Audit', `${shown.length} events`);
  };

  return (
    <>
      <div className="aa-toolbar">
        <DateRangeButton from={from} to={to} onApply={(f, t) => { setFrom(f); setTo(t); }} />
        <select className="cf-select aa-select" value={fUser} onChange={(e) => setFUser(e.target.value)}>
          {options.users.map((o) => <option key={o}>{o}</option>)}
        </select>
        <select className="cf-select aa-select" value={fFeature} onChange={(e) => setFFeature(e.target.value)}>
          {options.features.map((o) => <option key={o}>{o}</option>)}
        </select>
        <select className="cf-select aa-select" value={fAction} onChange={(e) => setFAction(e.target.value)}>
          {options.actions.map((o) => <option key={o}>{o}</option>)}
        </select>
        <button type="button" className="aa-btn" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'aa-spin' : ''} /> Refresh
        </button>
        <span className="aa-spacer" />
        <ExportMenu onCsv={exportCsv} onXlsx={exportXlsx} disabled={!shown.length} />
      </div>

      {error && <div className="aa-error"><AlertTriangle size={16} /> {error}</div>}
      {!events && !error && <div className="aa-loading">Loading audit trail…</div>}

      {events && (
        <>
          <div className="aa-count">
            {shown.length === events.length
              ? `${events.length} events`
              : `${shown.length} of ${events.length} events`} · {from} → {to}
          </div>
          <div className="aa-table-wrap">
            <table className="aa-table aa-audit">
              <thead>
                <tr>
                  <th>Time (IST)</th><th>Officer</th><th>Role</th>
                  <th>Feature</th><th>Action</th><th>IP</th><th>Location</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 500).map((e, i) => (
                  <tr key={i} title={e.device}>
                    <td className="aa-time">{e.istTime}</td>
                    <td>
                      <div className="aa-user">
                        <span className="aa-user-name">{e.name || '—'}</span>
                        <span className="aa-user-email">{e.email}</span>
                      </div>
                    </td>
                    <td>
                      {e.role === 'admin'
                        ? <span className="aa-chip admin">Admin</span>
                        : (roleName(e) || '—')}
                    </td>
                    <td>{e.feature}</td>
                    <td>
                      <span className={`aa-chip act-${e.action === 'denied' ? 'denied' : e.action === 'view' ? 'view' : 'other'}`}>
                        {e.action}
                      </span>
                      {e.detail && <span className="aa-detail"> {e.detail}</span>}
                    </td>
                    <td className="aa-mono">{e.ip || '—'}</td>
                    <td>{e.location || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length > 500 && (
              <div className="aa-count">Showing the latest 500 — exports include all {shown.length}.</div>
            )}
          </div>
        </>
      )}
    </>
  );
}

export default function AccessAudit() {
  const [tab, setTab] = useState('roles');
  return (
    <div className="cf-page">
      <TopBar title="Access & Audit" />
      <div className="pp-body">
        <div className="aa-head">
          <div className="aa-title">
            <ShieldCheck size={20} strokeWidth={1.9} />
            <div>
              <h1>Access &amp; audit</h1>
              <p>Role-based access with a full activity trail.</p>
            </div>
          </div>
          <div className="seg-group" role="tablist">
            <button
              type="button" role="tab" aria-selected={tab === 'roles'}
              className={`seg-btn ${tab === 'roles' ? 'active' : ''}`}
              onClick={() => setTab('roles')}
            >
              Access control
            </button>
            <button
              type="button" role="tab" aria-selected={tab === 'audit'}
              className={`seg-btn ${tab === 'audit' ? 'active' : ''}`}
              onClick={() => setTab('audit')}
            >
              Audit log
            </button>
          </div>
        </div>
        {tab === 'roles' ? <RolesTab /> : <AuditTab />}
      </div>
    </div>
  );
}
