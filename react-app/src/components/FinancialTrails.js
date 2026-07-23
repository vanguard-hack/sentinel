import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, RefreshCw, Landmark } from 'lucide-react';
import { fetchFinancialData, buildFinancialTrails, formatRs, TYPOLOGIES } from '../utils/financial';
import NetworkGraph from './NetworkGraph';

const Tier = ({ t }) => <span className={`fc-tier fc-tier-${t.toLowerCase()}`}>{t}</span>;

function Kpi({ value, label }) {
  return (
    <div className="cl-kpi">
      <span className="cl-kpi-value">{value}</span>
      <span className="cl-kpi-label">{label}</span>
    </div>
  );
}

export default function FinancialTrails() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  const { summary, alerts, typologyCounts, flagged, netSpec } = data;

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
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head">
          <h2>Prioritised alerts</h2>
          <span className="rp-card-sub">Entities ranked by composite laundering-risk score — each with the typologies that triggered it and a plain-language read</span>
        </div>
        <div className="rp-card-body">
          <div className="cf-scroll">
            <table className="fc-table ft-alert-table">
              <thead>
                <tr>
                  <th>Entity</th><th>Risk</th><th>Score</th>
                  <th>Typologies</th><th>Flagged value</th><th>Assessment</th><th>FIRs</th>
                </tr>
              </thead>
              <tbody>
                {alerts.slice(0, 50).map((a) => (
                  <tr key={a.person}>
                    <td>{a.name} <span className="fc-pid">{a.person}</span></td>
                    <td><Tier t={a.tier} /></td>
                    <td>{a.score}</td>
                    <td className="ft-flags">
                      {a.typologies.map((k) => <span key={k} className="ft-flag">{TYPOLOGIES[k].label}</span>)}
                    </td>
                    <td>{formatRs(a.value)}</td>
                    <td className="ft-narrative">{a.narrative}</td>
                    <td className="fc-pid">{a.firs.join(', ')}</td>
                  </tr>
                ))}
                {!alerts.length && <tr><td colSpan={7} className="rp-empty">No entities of interest.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Flagged transactions */}
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head">
          <h2>Flagged transactions</h2>
          <span className="rp-card-sub">Individual transfers driving the alerts — each links back to its FIR for follow-up</span>
        </div>
        <div className="rp-card-body">
          <div className="cf-scroll">
            <table className="fc-table">
              <thead>
                <tr>
                  <th>From</th><th>To</th><th>Amount</th><th>Channel</th><th>Why flagged</th><th>FIR</th>
                </tr>
              </thead>
              <tbody>
                {flagged.slice(0, 80).map((t) => (
                  <tr key={t.id}>
                    <td>{t.fromLabel}</td>
                    <td>{t.toLabel}</td>
                    <td>{formatRs(t.amount)}</td>
                    <td>{t.channel}</td>
                    <td className="ft-flags">
                      {t.reasons.map((r) => <span key={r} className="ft-flag">{r}</span>)}
                    </td>
                    <td className="fc-pid">{t.crimeNo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
