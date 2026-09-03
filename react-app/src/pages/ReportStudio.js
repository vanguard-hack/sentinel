import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ScrollText, Search, AlertTriangle, FileText, NotebookPen, UserX, Gavel,
  HeartPulse, UserSearch, PackageSearch, ClipboardList, ShieldAlert,
  TrendingUp, BarChart3, Scale, Trash2, FileDown, Link2, ChevronLeft, ChevronRight,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import { useConfirm } from '../components/ConfirmDialog';
import { REPORT_TYPES, reportTypeById } from '../data/reportTemplates';
import { listReports, getReport, deleteReport, downloadReportPdf } from '../utils/reportStudio';
import { logAudit } from '../utils/audit';
import { useTranslation } from 'react-i18next';

const TYPE_ICONS = {
  fir: FileText, 'case-diary': NotebookPen, arrest: UserX, 'charge-sheet': Gavel,
  udr: HeartPulse, 'missing-person': UserSearch, seizure: PackageSearch,
  'station-gd': ClipboardList, 'law-order': ShieldAlert, 'crime-analysis': TrendingUp,
  performance: BarChart3, 'case-status': Scale,
};

const fmtDate = (ts) =>
  ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export default function ReportStudio() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [reports, setReports] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [busyId, setBusyId] = useState(null);
  // The saved list is a browsing surface, not an archive dump — a station with
  // a few hundred reports should not scroll past all of them to reach the
  // filters underneath.
  const PER_PAGE = 8;
  const [page, setPage] = useState(0);

  const refresh = useCallback(() => {
    listReports().then(setReports).catch((e) => { setError(e.message); setReports([]); });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    if (!reports) return [];
    const needle = q.trim().toLowerCase();
    return reports.filter((r) => {
      if (typeFilter !== 'all' && r.typeId !== typeFilter) return false;
      if (!needle) return true;
      const type = reportTypeById(r.typeId);
      return `${r.title} ${r.refNo || ''} ${type ? type.name : ''} ${r.createdByName || ''}`.toLowerCase().includes(needle);
    });
  }, [reports, q, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  // Clamped rather than reset: deleting the last report on page 3 should land
  // on page 2, not throw the officer back to the top of the list.
  const cur = Math.min(page, pageCount - 1);
  const pageReports = filtered.slice(cur * PER_PAGE, cur * PER_PAGE + PER_PAGE);
  useEffect(() => { setPage(0); }, [q, typeFilter]);

  const remove = async (r) => {
    const ok = await confirm({
      title: t('reportStudio.deleteTitle', { title: r.title }),
      body: t('reportStudio.deleteBody'),
      confirmLabel: t('reportStudio.deleteConfirm'),
      tone: 'danger',
    });
    if (!ok) return;
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
    } catch (e) {
      setError(e.message);
    }
    setBusyId(null);
  };

  return (
    <div className="cf-page">
      <TopBar title={t('reportStudio.title')} subtitle={t('reportStudio.subtitle')} />
      <div className="pp-body">
        <div className="aa-head">
          <div className="aa-title">
            <ScrollText size={20} strokeWidth={1.9} />
            <div>
              <h1>{t('reportStudio.title')}</h1>
<p>{t('reportStudio.intro')}</p>
            </div>
          </div>
        </div>

        <h2 className="rb-section-title">{t('reportStudio.startNew')}</h2>
        <div className="rb-type-grid">
          {REPORT_TYPES.map((rt) => {
            const Icon = TYPE_ICONS[rt.id] || FileText;
            return (
              <button
                key={rt.id}
                type="button"
                className="rb-type-card"
                onClick={() => navigate(`/report-studio/new?type=${rt.id}`)}
              >
                <span className="rb-type-icon" style={{ color: rt.accent, background: `color-mix(in srgb, ${rt.accent} 12%, transparent)` }}>
                  <Icon size={19} strokeWidth={1.8} />
                </span>
                <span className="rb-type-name">{rt.name}</span>
                <span className="rb-type-meta">
                  <span className="rb-chip">{rt.form}</span>
                  <span className="rb-chip dim">{rt.law}</span>
                </span>
                <span className="rb-type-blurb">{rt.blurb}</span>
                <span className="rb-type-by">{t('reportStudio.preparedBy')}: {rt.preparedBy}</span>
              </button>
            );
          })}
        </div>

        <h2 className="rb-section-title">
          {t('reportStudio.saved')} {reports ? <span className="rb-count">({filtered.length})</span> : null}
        </h2>
        <div className="aa-toolbar rb-filters">
          <div className="cf-search">
            <Search size={15} className="cf-search-icon" />
            <input
              className="cf-search-input"
              placeholder={t('reportStudio.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select className="aa-select rb-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">{t('common.allTypes')}</option>
            {REPORT_TYPES.map((rt) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
          </select>
        </div>

        {error && <div className="aa-error"><AlertTriangle size={16} /> {error}</div>}
        {!reports && <div className="aa-loading">{t('common.loading')}</div>}
        {reports && !filtered.length && (
          <div className="rb-empty">{t('reportStudio.empty')}</div>
        )}

        <div className="rb-saved-list">
          {pageReports.map((r) => {
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
                  </div>
                  <div className="rb-saved-sub">
                    {type ? type.name : r.typeId} · {r.pageCount || 0} page{(r.pageCount || 0) === 1 ? '' : 's'} · Updated {fmtDate(r.updatedAt)}{r.createdByName ? ` · ${r.createdByName}` : ''}
                    {r.caseMasterId && (
                      <> · <span className="rb-saved-case"><Link2 size={11} /> {r.crimeNo || 'linked case'}</span></>
                    )}
                  </div>
                </div>
                <div className="rb-saved-actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="cf-icon-btn" title={t('reportStudio.downloadPdf')} disabled={busyId === r.id} onClick={() => download(r)}><FileDown size={15} /></button>
                  <button type="button" className="cf-icon-btn danger" title={t('common.delete')} disabled={busyId === r.id} onClick={() => remove(r)}><Trash2 size={15} /></button>
                </div>
              </div>
            );
          })}
        </div>

        {filtered.length > PER_PAGE && (
          <div className="inv-pager rb-pager">
            <div className="cl-pager-nav" role="group" aria-label="Saved report pages">
              <button type="button" disabled={cur === 0}
                onClick={() => setPage(cur - 1)} aria-label={t('common.prevPage')}>
                <ChevronLeft size={15} />
              </button>
              <button type="button" disabled={cur >= pageCount - 1}
                onClick={() => setPage(cur + 1)} aria-label={t('common.nextPage')}>
                <ChevronRight size={15} />
              </button>
            </div>
            <span className="rb-pager-count">
              {cur * PER_PAGE + 1}–{Math.min(filtered.length, (cur + 1) * PER_PAGE)} of {filtered.length}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
