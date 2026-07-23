import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { RefreshCw, AlertTriangle, Siren, ShieldAlert, Info } from 'lucide-react';
import {
  fetchPredictData, weeklyCounts, holtForecast, districtRisk, offenderRisk, detectAnomalies,
} from '../utils/predict';
import { ForecastChart, BarList } from './Charts';

function Card({ title, subtitle, wide, children }) {
  return (
    <section className={`rp-card ${wide ? 'rp-card-wide' : ''}`}>
      <div className="rp-card-head">
        <h2>{title}</h2>
        {subtitle && <span className="rp-card-sub">{subtitle}</span>}
      </div>
      <div className="rp-card-body">{children}</div>
    </section>
  );
}

const TierChip = ({ tier }) => (
  <span className={`fc-tier fc-tier-${tier.toLowerCase()}`}>{tier}</span>
);

const HORIZONS = [
  { label: '30 days', weeks: 4 },
  { label: '60 days', weeks: 9 },
  { label: '90 days', weeks: 13 },
];

// Trim long histories so the forecast horizon stays readable on screen.
const tail = (series, n = 40) => series.slice(-n);

export default function Forecasts() {
  const [data, setData] = useState(null); // { cases, accused }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [horizon, setHorizon] = useState(HORIZONS[1]);
  const [head, setHead] = useState('');
  const [district, setDistrict] = useState('');
  const [riskPage, setRiskPage] = useState(1);
  const RISK_PER_PAGE = 8;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchPredictData());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const heads = useMemo(
    () => (data ? [...new Set(data.cases.map((c) => c.head))].sort() : []),
    [data]
  );
  const districts = useMemo(
    () => (data ? [...new Set(data.cases.map((c) => c.district))].filter((d) => d !== 'Unknown').sort() : []),
    [data]
  );
  useEffect(() => { if (heads.length && !head) setHead(heads[0]); }, [heads, head]);
  useEffect(() => { if (districts.length && !district) setDistrict(districts[0]); }, [districts, district]);

  const model = useMemo(() => {
    if (!data) return null;
    const { cases, accused } = data;
    const overallSeries = weeklyCounts(cases.map((c) => c.ts));
    const headSeries = weeklyCounts(cases.filter((c) => c.head === head).map((c) => c.ts));
    const districtSeries = weeklyCounts(cases.filter((c) => c.district === district).map((c) => c.ts));
    const offenders = offenderRisk(cases, accused);
    const scoreDist = [
      { label: '0–19', value: 0 }, { label: '20–39', value: 0 }, { label: '40–59', value: 0 },
      { label: '60–79', value: 0 }, { label: '80–100', value: 0 },
    ];
    offenders.forEach((o) => { scoreDist[Math.min(4, Math.floor(o.score / 20))].value++; });
    return {
      overall: { history: tail(overallSeries), fc: holtForecast(overallSeries, horizon.weeks) },
      byHead: { history: tail(headSeries), fc: holtForecast(headSeries, horizon.weeks) },
      byDistrict: { history: tail(districtSeries), fc: holtForecast(districtSeries, horizon.weeks) },
      risk: districtRisk(cases),
      offenders: offenders.slice(0, 10),
      scoreDist,
      alerts: detectAnomalies(cases),
    };
  }, [data, head, district, horizon]);

  if (error) {
    return (
      <div className="cf-state cf-error">
        <AlertTriangle size={22} />
        <p>{error}</p>
        <button className="cf-retry" onClick={load}>Retry</button>
      </div>
    );
  }
  if (loading || !model) {
    return (
      <div className="cf-state">
        <div className="cf-spinner" />
        <p>Training forecasts…</p>
      </div>
    );
  }

  const labelEvery = (h) => Math.max(1, Math.ceil((h.history.length + horizon.weeks) / 12));

  return (
    <>
      {/* Alerts first — the early-warning layer */}
      <Card
        title="Anomaly alerts"
        subtitle="Weeks running ≥2σ above their trailing 12-week baseline"
        wide
      >
        {model.alerts.length === 0 ? (
          <div className="rp-empty">No unusual spikes detected — activity is within normal variance.</div>
        ) : (
          <div className="fc-alerts">
            {model.alerts.slice(0, 6).map((a) => (
              <div key={`${a.kind}-${a.label}`} className="fc-alert">
                <Siren size={16} />
                <div>
                  <strong>{a.label}</strong>
                  <span>
                    {a.actual} FIRs in wk of {a.week} vs ~{a.expected} expected
                    · z = {a.z} · {a.kind === 'head' ? 'crime type' : 'district'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Volume forecasts */}
      <div className="fc-toolbar">
        <span className="fc-toolbar-label">Forecast horizon</span>
        <select
          className="cf-select fc-horizon-select"
          value={horizon.label}
          onChange={(e) => setHorizon(HORIZONS.find((h) => h.label === e.target.value))}
        >
          {HORIZONS.map((h) => <option key={h.label} value={h.label}>{h.label}</option>)}
        </select>
        <button className="cf-icon-btn" onClick={load} title="Refresh" disabled={loading}>
          <RefreshCw size={15} />
        </button>
      </div>

      <div className="rp-grid">
        <Card
          title="FIR volume forecast"
          subtitle={`Weekly registrations, all Karnataka · Holt exponential smoothing (α=${model.overall.fc?.alpha ?? '—'}, β=${model.overall.fc?.beta ?? '—'})`}
          wide
        >
          <ForecastChart history={model.overall.history} forecast={model.overall.fc} labelEvery={labelEvery(model.overall)} />
        </Card>

        <Card title="Forecast by crime head" subtitle="Weekly registrations for one crime group">
          <select className="cf-select fc-select" value={head} onChange={(e) => setHead(e.target.value)}>
            {heads.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <ForecastChart history={model.byHead.history} forecast={model.byHead.fc} labelEvery={labelEvery(model.byHead)} />
        </Card>

        <Card title="Forecast by district" subtitle="Weekly registrations for one district">
          <select className="cf-select fc-select" value={district} onChange={(e) => setDistrict(e.target.value)}>
            {districts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <ForecastChart history={model.byDistrict.history} forecast={model.byDistrict.fc} labelEvery={labelEvery(model.byDistrict)} />
        </Card>

        {/* District risk board */}
        <Card
          title="District risk — next month"
          subtitle="Blend of recent level (60%) and 8-week growth (40%); tiers are tertiles"
          wide
        >
          <div className="cf-scroll">
            <table className="fc-table">
              <thead>
                <tr>
                  <th>District</th><th>Risk</th><th>Score</th>
                  <th>Last 8 wks</th><th>Trend</th><th>Predicted next 4 wks</th>
                </tr>
              </thead>
              <tbody>
                {model.risk
                  .slice((riskPage - 1) * RISK_PER_PAGE, riskPage * RISK_PER_PAGE)
                  .map((r) => (
                    <tr key={r.district}>
                      <td>{r.district}</td>
                      <td><TierChip tier={r.tier} /></td>
                      <td>{r.score}</td>
                      <td>{r.recent} FIRs</td>
                      <td className={r.growth > 0.05 ? 'fc-up' : r.growth < -0.05 ? 'fc-down' : ''}>
                        {r.growth > 0 ? '+' : ''}{Math.round(r.growth * 100)}%
                      </td>
                      <td>{r.predicted != null ? `~${r.predicted} FIRs` : '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {model.risk.length > RISK_PER_PAGE && (
            <div className="inv-pagination">
              <button className="inv-page-btn" disabled={riskPage <= 1} onClick={() => setRiskPage((p) => p - 1)}>Prev</button>
              <span className="inv-page-info">
                Page {riskPage} of {Math.ceil(model.risk.length / RISK_PER_PAGE)}
              </span>
              <button
                className="inv-page-btn"
                disabled={riskPage >= Math.ceil(model.risk.length / RISK_PER_PAGE)}
                onClick={() => setRiskPage((p) => p + 1)}
              >Next</button>
            </div>
          )}
        </Card>

        {/* Repeat offender risk */}
        <Card
          title="Repeat-offender risk"
          subtitle="Additive score: frequency ≤40 · recency ≤25 · severity ≤20 · network ≤15 — hover a bar for the breakdown"
          wide
        >
          <div className="cf-scroll">
            <table className="fc-table">
              <thead>
                <tr>
                  <th>Offender</th><th>Risk</th><th>Score</th><th>FIRs</th>
                  <th>Last offence</th><th>Co-accused</th><th>Why</th>
                </tr>
              </thead>
              <tbody>
                {model.offenders.map((o) => (
                  <tr key={o.person}>
                    <td>{o.name} <span className="fc-pid">{o.person}</span></td>
                    <td><TierChip tier={o.tier} /></td>
                    <td>{o.score}</td>
                    <td>{o.firs}</td>
                    <td>{o.daysSince} days ago</td>
                    <td>{o.partners}</td>
                    <td>
                      <div className="fc-why" title={
                        `frequency ${o.parts.frequency} · recency ${o.parts.recency} · severity ${o.parts.severity} · network ${o.parts.network}`
                      }>
                        {['frequency', 'recency', 'severity', 'network'].map((k, i) => (
                          <span
                            key={k}
                            className="fc-why-seg"
                            style={{ width: `${o.parts[k]}%`, background: `var(--rp-cat-${i})` }}
                          />
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="fc-why-legend">
            {['Frequency', 'Recency', 'Severity', 'Network'].map((k, i) => (
              <span key={k}><i style={{ background: `var(--rp-cat-${i})` }} /> {k}</span>
            ))}
          </div>
        </Card>

        <Card title="Risk-score distribution" subtitle="All repeat offenders (2+ FIRs) by score band" wide>
          <BarList data={model.scoreDist} height={320} straightLabels />
        </Card>

        <Card title="Method notes" subtitle="How to read these predictions">
          <ul className="fc-notes">
            <li><ShieldAlert size={13} /> Decision support only — patterns for human review, never automated targeting.</li>
            <li><Info size={13} /> No protected attributes (religion, caste, gender) are used as model features.</li>
            <li><Info size={13} /> Weekly aggregates: with ~2,200 FIRs, finer grains would forecast noise. Bands are honest 95% intervals.</li>
            <li><Info size={13} /> Forecasts: Holt exponential smoothing, grid-searched. Risk tiers: level + growth percentiles. Alerts: z ≥ 2 vs trailing 12 weeks.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
