import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  NotebookPen, Search, X, Plus, AlertTriangle, ChevronRight, BookOpen,
} from 'lucide-react';
import TopBar from '../components/TopBar';
import {
  listInvestigations, createInvestigation, searchCases, fetchCaseSections,
  coldCaseFlag, statusColor, STATUS_OPTIONS,
} from '../utils/investigation';
import { loadPersonnel } from '../utils/personnel';

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
  const navigate = useNavigate();
  const [cases, setCases] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('All');
  const [showNew, setShowNew] = useState(false);

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

  return (
    <div className="cf-page">
      <TopBar title="Investigation Diary" />
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
            <Plus size={15} /> New investigation
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
            {cases.length ? 'No investigations match your filters.' : 'No investigations opened yet — start one above.'}
          </div>
        )}

        {shown.length > 0 && (
          <div className="inv-grid">
            {shown.map((c) => {
              const cold = coldCaseFlag(c);
              return (
                <button key={c.caseMasterId} className="inv-card" onClick={() => navigate(`/investigation-diary/${c.caseMasterId}`)}>
                  <div className="inv-card-top">
                    <span className="inv-card-crime">{c.crimeNo || `Case ${c.caseMasterId}`}</span>
                    <span className={`aa-chip inv-status-${statusColor(c.status)}`}>{c.status}</span>
                  </div>
                  <div className="inv-card-type">{c.caseType || 'Uncategorised'}{c.sections ? ` · ${c.sections}` : ''}</div>
                  <div className="inv-card-meta">
                    <span>{c.ioRank ? `${c.ioRank} ` : ''}{c.ioName || 'Unassigned IO'}</span>
                    <span>{c.station}{c.district ? `, ${c.district}` : ''}</span>
                  </div>
                  <div className="inv-card-foot">
                    <span>{c.diaryCount} diary {c.diaryCount === 1 ? 'entry' : 'entries'}</span>
                    <span>Last: {c.lastDiaryDate || 'none yet'}</span>
                    {cold && <span className={`inv-cold-badge inv-cold-${cold.level}`}>{cold.label}</span>}
                  </div>
                </button>
              );
            })}
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
