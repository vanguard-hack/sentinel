import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  NotebookPen, Search, X, Plus, AlertTriangle, ChevronRight, ChevronLeft, BookOpen,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import {
  listInvestigations, createInvestigation, searchCases, fetchCaseSections,
  statusColor, STATUS_OPTIONS,
} from '../utils/investigation';
import { loadPersonnel } from '../utils/personnel';
import { useTranslation } from 'react-i18next';

// Sentinel prints dates as en-IN everywhere else — including the case page this
// card links to. Parsed as local midnight, not UTC, so the day never slips.
const fmtDay = (iso) =>
  iso
    ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
      })
    : '';

function NewInvestigationModal({ onClose, onCreated }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState(null);
  const [officers, setOfficers] = useState(null);
  const [ioId, setIoId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const timer = useRef(null);

  useEffect(() => { loadPersonnel().then((d) => setOfficers(d.officers)).catch(() => setOfficers([])); }, []);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!q.trim()) { setResults(null); return; }
    setSearching(true);
    timer.current = setTimeout(async () => {
      try {
        setResults(await searchCases(q));
      } catch (e) {
        setError(e.message);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer.current);
  }, [q]);

  const officer = officers?.find((o) => o.id === ioId);

  const open = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const sections = await fetchCaseSections(picked.caseMasterId);
      const rec = await createInvestigation({
        caseMasterId: picked.caseMasterId,
        crimeNo: picked.crimeNo,
        caseNo: picked.caseNo,
        station: picked.station,
        district: picked.district,
        caseType: picked.caseType,
        registeredDate: picked.registeredDate,
        sections,
        ioEmployeeId: officer?.id || '',
        ioName: officer?.name || '',
        ioRank: officer?.rankAbbr || '',
      });
      onCreated(rec.record);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inv-modal-scrim" onClick={onClose}>
      <div className="inv-modal" onClick={(e) => e.stopPropagation()}>
        <div className="inv-modal-head">
          <h3>Open a new investigation</h3>
          <button className="inv-modal-x" onClick={onClose}><X size={18} /></button>
        </div>

        {!picked ? (
          <>
            <p className="aa-hint">
              Find the FIR to attach a Case Diary to — search by Crime No. or Case No.
              Case identifiers (station, district, sections) are pulled straight from the
              Data Store so the diary can never drift from the FIR.
            </p>
            <div className="cf-search">
              <Search size={15} className="cf-search-icon" />
              <input
                className="cf-search-input"
                autoFocus
                placeholder="Crime No. or Case No…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            {error && <div className="aa-error"><AlertTriangle size={16} /> {error}</div>}
            <div className="inv-search-results">
              {searching && <div className="aa-loading">Searching…</div>}
              {results && !searching && results.length === 0 && (
                <div className="aa-loading">No matching FIRs.</div>
              )}
              {results?.map((c) => (
                <button key={c.caseMasterId} className="inv-search-row" onClick={() => setPicked(c)}>
                  <div className="inv-search-main">
                    <span className="inv-search-crime">{c.crimeNo || `Case ${c.caseMasterId}`}</span>
                    <span className="inv-search-sub">{c.caseType} · {c.station}, {c.district}</span>
                  </div>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="inv-picked">
              <BookOpen size={18} />
              <div>
                <div className="inv-search-crime">{picked.crimeNo || `Case ${picked.caseMasterId}`}</div>
                <div className="inv-search-sub">{picked.caseType} · {picked.station}, {picked.district} · Registered {picked.registeredDate || '—'}</div>
              </div>
            </div>
            <label className="aa-range" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6, marginTop: 12 }}>
              Investigating Officer
              <select className="cf-select" value={ioId} onChange={(e) => setIoId(e.target.value)}>
                <option value="">— select officer —</option>
                {(officers || []).map((o) => (
                  <option key={o.id} value={o.id}>{o.name} · {o.rankAbbr} · {o.unit}</option>
                ))}
              </select>
            </label>
            {error && <div className="aa-error"><AlertTriangle size={16} /> {error}</div>}
            <div className="inv-modal-actions">
              <button className="aa-btn" onClick={() => setPicked(null)}>Back</button>
              <button className="aa-btn primary" onClick={open} disabled={busy}>
                {busy ? 'Opening…' : 'Open investigation'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function InvestigationDiary() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [cases, setCases] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('All');
  const [showNew, setShowNew] = useState(false);
  // Cards per page, in multiples of nine — three full rows on the usual
  // three-column grid, so the last row is never ragged.
  const [perPage, setPerPage] = useState(12);
  const [page, setPage] = useState(0);

  const load = useCallback(() => {
    listInvestigations().then(setCases).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    if (!cases) return [];
    const query = q.trim().toLowerCase();
    return cases.filter((c) => {
      if (status !== 'All' && c.status !== status) return false;
      if (!query) return true;
      return [c.crimeNo, c.caseNo, c.ioName, c.station, c.district, c.caseType]
        .some((v) => String(v || '').toLowerCase().includes(query));
    });
  }, [cases, q, status]);

  // Filtering can shrink the list under the current page — clamp rather than
  // stranding the officer on an empty page.
  const pages = Math.max(1, Math.ceil(shown.length / perPage));
  const cur = Math.min(page, pages - 1);
  const pageCases = shown.slice(cur * perPage, cur * perPage + perPage);
  useEffect(() => { setPage(0); }, [q, status, perPage]);

  return (
    <div className="cf-page">
      <TopBar title={t('diary.title')} />
      <div className="pp-body">
        <div className="aa-head">
          <div className="aa-title">
            <NotebookPen size={20} strokeWidth={1.9} />
            <div>
              <h1>Investigation diary</h1>
              <p>Case Diary Statements under Section 172 BNSS — mapped to the CCTNS IIF1–IIF5 forms.</p>
            </div>
          </div>
          <button type="button" className="aa-btn primary" onClick={() => setShowNew(true)}>
            <Plus size={15} /> {t('diary.newInvestigation')}
          </button>
        </div>

        <div className="aa-toolbar">
          <div className="cf-search inv-list-search">
            <Search size={15} className="cf-search-icon" />
            <input
              className="cf-search-input"
              placeholder="Search crime no., IO, station, district…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select className="cf-select aa-select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option>All</option>
            {STATUS_OPTIONS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>

        {error && <div className="aa-error"><AlertTriangle size={16} /> {error}</div>}
        {!cases && !error && <div className="aa-loading">Loading investigations…</div>}
        {cases && !shown.length && (
          <div className="aa-loading">
{cases.length ? t('diary.noMatch') : t('diary.empty')}
          </div>
        )}

        {shown.length > 0 && (
          <div className="inv-grid">
            {pageCases.map((c) => {
              return (
                <button key={c.caseMasterId} className="inv-card" onClick={() => navigate(`/investigation-diary/${c.caseMasterId}`)}>
                  <div className="inv-card-top">
                    <span className="inv-card-crime">{c.crimeNo || `Case ${c.caseMasterId}`}</span>
                    <span className={`aa-chip inv-status-${statusColor(c.status)}`}>{c.status}</span>
                  </div>
                  <div className="inv-card-type">{c.caseType || t('diary.uncategorised')}{c.sections ? ` · ${c.sections}` : ''}</div>
                  <div className="inv-card-meta">
                    <span>{c.ioRank ? `${c.ioRank} ` : ''}{c.ioName || t('diary.unassigned')}</span>
                    <span>{c.station}{c.district ? `, ${c.district}` : ''}</span>
                  </div>
                  <div className="inv-card-foot">
                    <span>{t('diary.diaryEntries', { count: c.diaryCount })}</span>
                    <span>{t('diary.lastUpdated')}: {fmtDay(c.lastDiaryDate) || t('diary.none')}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {shown.length > perPage && (
          <div className="inv-pager">
            <div className="cl-pager-nav" role="group" aria-label="Investigation pages">
              <button type="button" disabled={cur === 0}
                onClick={() => setPage(cur - 1)} aria-label={t('common.prevPage')}>
                <ChevronLeft size={15} />
              </button>
              <button type="button" disabled={cur >= pages - 1}
                onClick={() => setPage(cur + 1)} aria-label={t('common.nextPage')}>
                <ChevronRight size={15} />
              </button>
            </div>
            <label className="inv-perpage">
              <span>{t('common.perPage')}</span>
              <select
                className="aa-select"
                value={perPage}
                onChange={(e) => setPerPage(Number(e.target.value))}
              >
                {[12, 24, 36, 48].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
        )}
      </div>

      {showNew && (
        <NewInvestigationModal
          onClose={() => setShowNew(false)}
          onCreated={(rec) => navigate(`/investigation-diary/${rec.caseMasterId}`)}
        />
      )}
    </div>
  );
}
