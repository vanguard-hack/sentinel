import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ScrollText, Search, AlertTriangle, FileText, NotebookPen, UserX, Gavel,
  HeartPulse, UserSearch, PackageSearch, ClipboardList, ShieldAlert,
  TrendingUp, BarChart3, Scale, Copy, Trash2, FileDown, Lock,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import { REPORT_TYPES, reportTypeById } from '../data/reportTemplates';
import { listReports, getReport, saveReport, deleteReport, newReportId, downloadReportPdf } from '../utils/reportStudio';
import { logAudit } from '../utils/audit';

const TYPE_ICONS = {
  fir: FileText, 'case-diary': NotebookPen, arrest: UserX, 'charge-sheet': Gavel,
  udr: HeartPulse, 'missing-person': UserSearch, seizure: PackageSearch,
  'station-gd': ClipboardList, 'law-order': ShieldAlert, 'crime-analysis': TrendingUp,
  performance: BarChart3, 'case-status': Scale,
};

const fmtDate = (ts) =>
  ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export default function ReportStudio() {
  const navigate = useNavigate();
  const [reports, setReports] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [busyId, setBusyId] = useState(null);

  const refresh = useCallback(() => {
    listReports().then(setReports).catch((e) => { setError(e.message); setReports([]); });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    if (!reports) return [];
    const needle = q.trim().toLowerCase();
    return reports.filter((r) => {
      if (typeFilter !== 'all' && r.typeId !== typeFilter) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!needle) return true;
      const type = reportTypeById(r.typeId);
      return `${r.title} ${r.refNo || ''} ${type ? type.name : ''} ${r.createdByName || ''}`.toLowerCase().includes(needle);
    });
  }, [reports, q, typeFilter, statusFilter]);

  const duplicate = async (r) => {
    setBusyId(r.id);
    try {
      const full = await getReport(r.id);
      const copy = { ...full, id: newReportId(), title: `${full.title} (copy)`, status: 'draft' };
      await saveReport(copy);
      logAudit('duplicate-report', 'Report Studio', full.title);
      refresh();
    } catch (e) { setError(e.message); }
    setBusyId(null);
  };

  const remove = async (r) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${r.title}"? The stored copy is retained in the archive but it disappears from this list.`)) return;
    setBusyId(r.id);
    try { await deleteReport(r.id); refresh(); } catch (e) { setError(e.message); }
    setBusyId(null);
  };

  const download = async (r) => {
    setBusyId(r.id);
    try {
      const full = await getReport(r.id);
      await downloadReportPdf(full);
      logAudit('download-report', 'Report Studio', full.title);
    } catch (e) { setError(e.message); }
    setBusyId(null);
  };

  return (
    <div className="cf-page">
      <TopBar title="Report Studio" subtitle="Draft, edit & file statutory police reports" />
      <div className="pp-body">
        <div className="aa-head">
          <div className="aa-title">
            <ScrollText size={20} strokeWidth={1.9} />
            <div>
              <h1>Report Studio</h1>
              <p>Pick a report type to start from its prescribed template — CCTNS IIF forms, BNSS registers and departmental review formats. Drafts autosave to the archive.</p>
            </div>
          </div>
        </div>

        <h2 className="rb-section-title">Start a new report</h2>
        <div className="rb-type-grid">
          {REPORT_TYPES.map((t) => {
            const Icon = TYPE_ICONS[t.id] || FileText;
            return (
              <button
                key={t.id}
                type="button"
                className="rb-type-card"
                onClick={() => navigate(`/report-studio/new?type=${t.id}`)}
              >
                <span className="rb-type-icon" style={{ color: t.accent, background: `color-mix(in srgb, ${t.accent} 12%, transparent)` }}>
                  <Icon size={19} strokeWidth={1.8} />
                </span>
                <span className="rb-type-name">{t.name}</span>
                <span className="rb-type-meta">
                  <span className="rb-chip">{t.form}</span>
                  <span className="rb-chip dim">{t.law}</span>
                </span>
                <span className="rb-type-blurb">{t.blurb}</span>
                <span className="rb-type-by">Prepared by: {t.preparedBy}</span>
              </button>
            );
          })}
        </div>

        <h2 className="rb-section-title">
          Saved reports {reports ? <span className="rb-count">({filtered.length})</span> : null}
        </h2>
        <div className="aa-toolbar">
          <div className="cf-search">
            <Search size={15} className="cf-search-icon" />
            <input
              className="cf-search-input"
              placeholder="Search by title, reference, type or officer…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select className="aa-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">All types</option>
            {REPORT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select className="aa-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="final">Finalized</option>
          </select>
        </div>

        {error && <div className="aa-error"><AlertTriangle size={16} /> {error}</div>}
        {!reports && <div className="aa-loading">Loading saved reports…</div>}
        {reports && !filtered.length && (
          <div className="rb-empty">No saved reports yet — pick a template above to draft the first one.</div>
        )}

        <div className="rb-saved-list">
          {filtered.map((r) => {
            const type = reportTypeById(r.typeId);
            const Icon = TYPE_ICONS[r.typeId] || FileText;
            return (
              <div key={r.id} className="rb-saved-row" role="button" tabIndex={0}
                onClick={() => navigate(`/report-studio/${r.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/report-studio/${r.id}`); }}>
                <span className="rb-type-icon sm" style={type ? { color: type.accent, background: `color-mix(in srgb, ${type.accent} 12%, transparent)` } : undefined}>
                  <Icon size={16} strokeWidth={1.8} />
                </span>
                <div className="rb-saved-main">
                  <div className="rb-saved-title">
                    {r.title}
                    {r.status === 'final' && <span className="rb-chip final"><Lock size={10} /> Final</span>}
                    {r.status !== 'final' && <span className="rb-chip draft">Draft</span>}
                  </div>
                  <div className="rb-saved-sub">
                    {type ? type.name : r.typeId} · {r.pageCount || 0} page{(r.pageCount || 0) === 1 ? '' : 's'} · Updated {fmtDate(r.updatedAt)}{r.createdByName ? ` · ${r.createdByName}` : ''}
                  </div>
                </div>
                <div className="rb-saved-actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="cf-icon-btn" title="Download PDF" disabled={busyId === r.id} onClick={() => download(r)}><FileDown size={15} /></button>
                  <button type="button" className="cf-icon-btn" title="Duplicate" disabled={busyId === r.id} onClick={() => duplicate(r)}><Copy size={15} /></button>
                  <button type="button" className="cf-icon-btn danger" title="Delete" disabled={busyId === r.id} onClick={() => remove(r)}><Trash2 size={15} /></button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
