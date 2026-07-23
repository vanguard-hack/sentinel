import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, RefreshCw, Landmark, ShieldAlert, Info } from 'lucide-react';
import { fetchFinancialData, buildFinancialTrails, formatRs } from '../utils/financial';
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
    return <div className="cf-state"><div className="cf-spinner" /><p>Tracing financial trails…</p></div>;
  }
  if (error) {
    return (
      <div className="cf-state cf-error">
        <AlertTriangle size={22} /><p>{error}</p>
        <button className="cf-retry" onClick={load}>Retry</button>
      </div>
    );
  }

  const { summary, persons, flagged, netSpec } = data;

  return (
    <>
      <section className="rp-card rp-card-wide">
        <div className="rp-card-head cl-head">
          <div>
            <h2><Landmark size={16} /> Financial trails & money-laundering signals</h2>
            <span className="rp-card-sub">
              Synthetic transactions modelled around accused named in economic, cyber &amp; property FIRs — demo, decision-support only
            </span>
          </div>
          <button className="cf-icon-btn" onClick={load} title="Rebuild"><RefreshCw size={15} /></button>
        </div>
        <div className="rp-card-body">
          <div className="cl-kpi-row">
            <Kpi value={summary.txns.toLocaleString()} label="Transactions analysed" />
            <Kpi value={summary.flagged.toLocaleString()} label="Flagged transactions" />
            <Kpi value={summary.persons.toLocaleString()} label="Persons of interest" />
            <Kpi value={summary.highRisk.toLocaleString()} label="High-risk channel / cash" />
            <Kpi value={formatRs(summary.value)} label="Flagged value" />
          </div>
        </div>
      </section>

      <section className="rp-card rp-card-wide">
        <div className="rp-card-head">
          <h2>Suspicious transaction network</h2>
          <span className="rp-card-sub">Persons of interest linked to counterparties and shell / mule accounts by flagged transfers</span>
        </div>
        <div className="rp-card-body">
          {netSpec.nodes.length
            ? <NetworkGraph spec={netSpec} initialZoom={0.8} />
            : <div className="rp-empty">No suspicious transaction network detected.</div>}
        </div>
      </section>

      <section className="rp-card rp-card-wide">
        <div className="rp-card-head">
          <h2>Persons of interest</h2>
          <span className="rp-card-sub">Ranked by money-laundering-signal score — leads for a financial-crime investigator to verify</span>
        </div>
        <div className="rp-card-body">
          <div className="cf-scroll">
            <table className="fc-table">
              <thead>
                <tr>
                  <th>Person</th><th>Risk</th><th>Score</th><th>Txns</th>
                  <th>Flagged</th><th>Flagged value</th><th>Channels</th><th>FIRs</th>
                </tr>
              </thead>
              <tbody>
                {persons.slice(0, 50).map((p) => (
                  <tr key={p.person}>
                    <td>{p.name} <span className="fc-pid">{p.person}</span></td>
                    <td><Tier t={p.tier} /></td>
                    <td>{p.score}</td>
                    <td>{p.txns}</td>
                    <td>{p.flagged}</td>
                    <td>{formatRs(p.value)}</td>
                    <td>{p.channels.join(', ')}</td>
                    <td>{p.cases}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="rp-card rp-card-wide">
        <div className="rp-card-head">
          <h2>Flagged transactions</h2>
          <span className="rp-card-sub">Each links back to its FIR for investigation follow-up</span>
        </div>
        <div className="rp-card-body">
          <div className="cf-scroll">
            <table className="fc-table">
              <thead>
                <tr>
                  <th>Date</th><th>Person</th><th>Amount</th><th>Channel</th>
                  <th>Counterparty</th><th>Why flagged</th><th>FIR</th>
                </tr>
              </thead>
              <tbody>
                {flagged.slice(0, 80).map((t) => (
                  <tr key={t.id}>
                    <td>{t.dateStr}</td>
                    <td>{t.name}</td>
                    <td>{formatRs(t.amount)}</td>
                    <td>{t.channel}</td>
                    <td>{t.counterLabel}</td>
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

      <section className="rp-card rp-card-wide">
        <div className="rp-card-head"><h2>Method &amp; guardrails</h2></div>
        <div className="rp-card-body">
          <ul className="fc-notes">
            <li><Info size={13} /> Transaction data is <strong>synthetic</strong> — the FIR schema has none; transactions are deterministically modelled around accused in economic / cyber / property cases to demonstrate the workflow.</li>
            <li><ShieldAlert size={13} /> Decision support only — every flag is a lead for a financial-crime investigator to verify, never a conclusion.</li>
            <li><Info size={13} /> Signals: structuring (kept below ₹50k), high-value cash, high-risk channels (hawala / crypto), rapid layering (≥4 transfers in 72h), and shell / mule accounts.</li>
            <li><Info size={13} /> Production use requires real STR/CTR feeds (FIU-IND), bank / UPI records, and legal authorisation.</li>
          </ul>
        </div>
      </section>
    </>
  );
}
