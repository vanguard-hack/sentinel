import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { AlertTriangle, RefreshCw, Landmark, ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchFinancialData, buildFinancialTrails, formatRs, TYPOLOGIES } from '../utils/financial';
import NetworkGraph from './NetworkGraph';

const Tier = ({ t }) => <span className={`fc-tier fc-tier-${t.toLowerCase()}`}>{t}</span>;
const ALERTS_PER_PAGE = 8;
const TXNS_PER_PAGE = 12;

function Kpi({ value, label }) {
  return (
    <div className="cl-kpi">
      <span className="cl-kpi-value">{value}</span>
      <span className="cl-kpi-label">{label}</span>
    </div>
  );
}

function Pagination({ page, pages, setPage }) {
  if (pages <= 1) return null;
  return (
    <div className="inv-pagination">
      <button className="inv-page-btn ft-arrow-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
        <ChevronLeft size={16} />
      </button>
      <span className="inv-page-info">Page {page} of {pages}</span>
      <button className="inv-page-btn ft-arrow-btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

export default function FinancialTrails() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Alert filters + paging
  const [aEntity, setAEntity] = useState('');
  const [aTier, setATier] = useState('');
  const [aTypo, setATypo] = useState('');
  const [aPage, setAPage] = useState(1);

  // Transaction filters + paging
  const [tParty, setTParty] = useState('');
  const [tChannel, setTChannel] = useState('');
  const [tReason, setTReason] = useState('');
  const [tPage, setTPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(buildFinancialTrails(await fetchFinancialData()));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const { summary, alerts, typologyCounts, flagged, netSpec } = data || {};

  // Distinct option lists for the filter dropdowns.
  const channelOpts = useMemo(
    () => (flagged ? [...new Set(flagged.map((t) => t.channel))].sort() : []),
    [flagged]
  );
  const reasonOpts = useMemo(
    () => (flagged ? [...new Set(flagged.flatMap((t) => t.reasons))].sort() : []),
    [flagged]
  );
  const typoOpts = useMemo(
    () => (alerts ? typologyCounts.map((t) => ({ key: t.key, label: t.label })) : []),
    [alerts, typologyCounts]
  );

  const filteredAlerts = useMemo(() => {
    if (!alerts) return [];
    const q = aEntity.trim().toLowerCase();
    return alerts.filter((a) =>
      (!q || a.name.toLowerCase().includes(q) || a.person.toLowerCase().includes(q)) &&
      (!aTier || a.tier === aTier) &&
      (!aTypo || a.typologies.includes(aTypo))
    );
  }, [alerts, aEntity, aTier, aTypo]);

  const filteredTxns = useMemo(() => {
    if (!flagged) return [];
    const q = tParty.trim().toLowerCase();
    return flagged.filter((t) =>
      (!q || t.fromLabel.toLowerCase().includes(q) || t.toLabel.toLowerCase().includes(q)) &&
      (!tChannel || t.channel === tChannel) &&
      (!tReason || t.reasons.includes(tReason))
    );
  }, [flagged, tParty, tChannel, tReason]);

  // Reset to page 1 when filters change.
  useEffect(() => { setAPage(1); }, [aEntity, aTier, aTypo]);
  useEffect(() => { setTPage(1); }, [tParty, tChannel, tReason]);

  const aPages = Math.max(1, Math.ceil(filteredAlerts.length / ALERTS_PER_PAGE));
  const tPages = Math.max(1, Math.ceil(filteredTxns.length / TXNS_PER_PAGE));
  const aRows = filteredAlerts.slice((aPage - 1) * ALERTS_PER_PAGE, aPage * ALERTS_PER_PAGE);
  const tRows = filteredTxns.slice((tPage - 1) * TXNS_PER_PAGE, tPage * TXNS_PER_PAGE);

  if (loading) {
    return <div className="cf-state"><div className="cf-spinner" /><p>Tracing money trails…</p></div>;
  }
  if (error) {
    return (
      <div className="cf-state cf-error">
        <AlertTriangle size={22} /><p>{error}</p>
        <button className="cf-retry" onClick={load}>Retry</button>
      </div>
    );
  }

  return (
    <>
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head cl-head">
          <div>
            <h2><Landmark size={16} /> Financial trails &amp; money-laundering typologies</h2>
            <span className="rp-card-sub">
              Synthetic transactions modelled around accused in economic, cyber &amp; property FIRs, screened against
              standard AML typologies — demo, analyst decision-support only
            </span>
          </div>
          <button className="cf-icon-btn" onClick={load} title="Rebuild"><RefreshCw size={15} /></button>
        </div>
        <div className="rp-card-body">
          <div className="cl-kpi-row">
            <Kpi value={summary.txns.toLocaleString()} label="Transactions analysed" />
            <Kpi value={summary.flagged.toLocaleString()} label="Flagged transactions" />
            <Kpi value={summary.entities.toLocaleString()} label="Entities of interest" />
            <Kpi value={summary.typologies.toLocaleString()} label="Typologies detected" />
            <Kpi value={formatRs(summary.value)} label="Flagged value" />
          </div>
        </div>
      </section>

      {/* Typology breakdown */}
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head">
          <h2>Laundering typologies detected</h2>
          <span className="rp-card-sub">Entities matching each pattern — the AML red-flag catalogue behind every alert</span>
        </div>
        <div className="rp-card-body">
          <div className="ft-typologies">
            {typologyCounts.map((t) => (
              <div key={t.key} className="ft-typo">
                <div className="ft-typo-top">
                  <span className="ft-typo-name">{t.label}</span>
                  <span className="ft-typo-count">{t.count}</span>
                </div>
                <span className="ft-typo-desc">{t.desc}</span>
              </div>
            ))}
            {!typologyCounts.length && <div className="rp-empty">No typologies triggered.</div>}
          </div>
        </div>
      </section>

      {/* Money-flow network */}
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head">
          <h2>Money-flow network</h2>
          <span className="rp-card-sub">Entities of interest linked to counterparties, mule and shell accounts by flagged transfers</span>
        </div>
        <div className="rp-card-body">
          {netSpec.nodes.length
            ? <NetworkGraph spec={netSpec} initialZoom={0.8} />
            : <div className="rp-empty">No suspicious money-flow network detected.</div>}
        </div>
      </section>

      {/* Prioritised alerts — analyst decision support */}
      <section className="rp-card rp-card-wide ft-section">
        <div className="rp-card-head">
          <h2>Prioritised alerts</h2>
          <span className="rp-card-sub">Entities ranked by composite laundering-risk score — each with the typologies that triggered it and a plain-language read</span>
        </div>
        <div className="rp-card-body">
          <div className="ft-filters">
            <input
              className="cf-search-input ft-filter-text"
              placeholder="Filter entity…"
              value={aEntity}
              onChange={(e) => setAEntity(e.target.value)}
            />
            <select className="cf-select" value={aTier} onChange={(e) => setATier(e.target.value)}>
              <option value="">All risk tiers</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Low">Low</option>
            </select>
            <select className="cf-select" value={aTypo} onChange={(e) => setATypo(e.target.value)}>
              <option value="">All typologies</option>
              {typoOpts.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            <span className="ft-count">{filteredAlerts.length} of {alerts.length}</span>
          </div>
          <div className="cf-scroll">
            <table className="fc-table ft-alert-table">
              <thead>
                <tr>
                  <th>Entity</th><th>Risk</th><th>Score</th>
                  <th>Typologies</th><th>Flagged value</th><th>Assessment</th><th>FIRs</th>
                </tr>
              </thead>
              <tbody>
                {aRows.map((a) => (
                  <tr key={a.person}>
                    <td className="ft-entity-cell">{a.name} <span className="fc-pid">{a.person}</span></td>
                    <td><Tier t={a.tier} /></td>
                    <td>{a.score}</td>
                    <td className="ft-flags">
                      {a.typologies.map((k) => <span key={k} className="ft-flag">{TYPOLOGIES[k].label}</span>)}
                    </td>
                    <td className="ft-num">{formatRs(a.value)}</td>
                    <td className="ft-narrative">{a.narrative}</td>
                    <td className="ft-firs fc-pid">{a.firs.join(', ')}</td>
                  </tr>
                ))}
                {!filteredAlerts.length && <tr><td colSpan={7} className="rp-empty">No entities match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pagination page={aPage} pages={aPages} setPage={setAPage} />
        </div>
      </section>

      {/* Flagged transactions */}
      <section className="rp-card rp-card-wide ft-section">
        <div className="rp-card-head">
          <h2>Flagged transactions</h2>
          <span className="rp-card-sub">Individual transfers driving the alerts — each links back to its FIR for follow-up</span>
        </div>
        <div className="rp-card-body">
          <div className="ft-filters">
            <input
              className="cf-search-input ft-filter-text"
              placeholder="Filter from / to…"
              value={tParty}
              onChange={(e) => setTParty(e.target.value)}
            />
            <select className="cf-select" value={tChannel} onChange={(e) => setTChannel(e.target.value)}>
              <option value="">All channels</option>
              {channelOpts.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className="cf-select" value={tReason} onChange={(e) => setTReason(e.target.value)}>
              <option value="">All reasons</option>
              {reasonOpts.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <span className="ft-count">{filteredTxns.length} of {flagged.length}</span>
          </div>
          <div className="cf-scroll">
            <table className="fc-table">
              <thead>
                <tr>
                  <th>From</th><th>To</th><th>Amount</th><th>Channel</th><th>Why flagged</th><th>FIR</th>
                </tr>
              </thead>
              <tbody>
                {tRows.map((t) => (
                  <tr key={t.id}>
                    <td>{t.fromLabel}</td>
                    <td>{t.toLabel}</td>
                    <td className="ft-num">{formatRs(t.amount)}</td>
                    <td>{t.channel}</td>
                    <td className="ft-flags">
                      {t.reasons.map((r) => <span key={r} className="ft-flag">{r}</span>)}
                    </td>
                    <td className="fc-pid">{t.crimeNo}</td>
                  </tr>
                ))}
                {!filteredTxns.length && <tr><td colSpan={6} className="rp-empty">No transactions match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
          <Pagination page={tPage} pages={tPages} setPage={setTPage} />
        </div>
      </section>
    </>
  );
}
