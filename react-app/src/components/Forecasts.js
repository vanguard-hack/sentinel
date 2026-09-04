import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { RefreshCw, AlertTriangle, Siren } from 'lucide-react';
import {
  fetchPredictData, fetchForecasts, toChartSeries,
  districtRisk, offenderRisk, detectAnomalies,
} from '../utils/predict';
import { ForecastChart } from './Charts';
import BarList from './charts/BarColumns';

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

/* What the number on screen is worth, in the card subtitle.
   `skillPct` is the model's improvement over the better of the two baselines a
   forecaster has to beat — repeating last week, and repeating the same week
   last year. A model that cannot beat both is not adding information, so the
   figure is published rather than buried. Measured on a held-out time split,
   NOT on QuickML's own console metric, which scores a random split and is
   optimistic on a table of lag features. */
const accuracyNote = (q) => (q
  ? `QuickML · monthly · typical error ±${q.mae} ${q.unit} (${q.mape}%) · `
    + `${q.skillPct}% better than a flat average`
  : 'QuickML');

const TierChip = ({ tier }) => (
  <span className={`fc-tier fc-tier-${tier.toLowerCase()}`}>{tier}</span>
);

// The models are MONTHLY, so a horizon is a count of months. 30/60/90 days
// map to 1/2/3; the pipelines return 6, which leaves slack because the dataset
// ends before today and the first months of the forecast are already history.
const HORIZONS = [
  { label: '30 days', months: 1 },
  { label: '60 days', months: 2 },
  { label: '90 days', months: 3 },
];

// Trim long histories so the forecast horizon stays readable on screen.
const tail = (series, n = 24) => series.slice(-n);

export default function Forecasts() {
  const [data, setData] = useState(null);   // { cases, accused } — risk & anomaly cards
  const [fc, setFc] = useState(null);       // live QuickML bundle — the three charts
  const [fcError, setFcError] = useState(null);
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
    setFcError(null);
    // The two loads are independent: the risk and anomaly cards are computed
    // in the browser from case data, while the three volume charts come from
    // the models. A model outage must not blank the rest of the page, so the
    // forecast failure is captured rather than thrown.
    const [caseData, bundle] = await Promise.all([
      fetchPredictData().catch((e) => { setError(e.message || String(e)); return null; }),
      fetchForecasts().catch((e) => { setFcError(e.message || String(e)); return null; }),
    ]);
    if (caseData) setData(caseData);
    if (bundle) setFc(bundle);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Options come from the MODEL, not from the case list: a series the model
  // was never trained on cannot be forecast, so offering it would produce an
  // empty chart with no explanation.
  const opts = (table) => (fc && fc[table]
    ? Object.values(fc[table].series)
      .map((s) => ({ key: s.key, label: s.label }))
      .sort((a, b) => a.label.localeCompare(b.label))
    : []);
  const heads = useMemo(() => opts('crimehead'), [fc]);        // eslint-disable-line react-hooks/exhaustive-deps
  const districts = useMemo(() => opts('district'), [fc]);     // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (heads.length && !head) setHead(heads[0].key); }, [heads, head]);
  useEffect(() => { if (districts.length && !district) setDistrict(districts[0].key); }, [districts, district]);

  const model = useMemo(() => {
    if (!data) return null;
    const { cases, accused } = data;
    const offenders = offenderRisk(cases, accused);
    const scoreDist = [
      { label: '0–19', value: 0 }, { label: '20–39', value: 0 },
      { label: '40–59', value: 0 }, { label: '60+', value: 0 },
    ];
    offenders.forEach((o) => { scoreDist[Math.min(3, Math.floor(o.score / 20))].value++; });
    return {
      risk: districtRisk(cases),
      offenders: offenders.slice(0, 10),
      scoreDist,
      alerts: detectAnomalies(cases),
    };
  }, [data]);

  /* The three volume charts, straight from the deployed models. `horizon`
     trims the prediction to 1, 2 or 3 months — the models always return all
     6, so changing the horizon re-slices rather than re-predicting, and costs
     no extra inference. */
  const charts = useMemo(() => {
    if (!fc) return null;
    const cut = (entry) => {
      const c = toChartSeries(entry);
      if (!c) return null;
      return {
        history: tail(c.history),
        fc: c.forecast
          ? { points: c.forecast.points.slice(0, horizon.months) }
          : null,
      };
    };
    return {
      overall: cut(fc.total),
      byHead: cut(fc.crimehead && fc.crimehead.series[head]),
      byDistrict: cut(fc.district && fc.district.series[district]),
    };
  }, [fc, head, district, horizon]);

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
        {fcError && (
          <Card title="FIR volume forecast" wide>
            <div className="cf-state cf-error">
              <AlertTriangle size={22} />
              <p>
                The forecasting models are unavailable, so no prediction is shown.
                <br /><span className="rp-card-sub">{fcError}</span>
              </p>
              <button className="cf-retry" onClick={load}>Retry</button>
            </div>
          </Card>
        )}

        {charts && (
          <>
            <Card
              title="FIR volume forecast"
              subtitle={`Monthly registrations, all Karnataka · ${accuracyNote(fc.total.quality)}`}
              wide
            >
              <ForecastChart history={charts.overall.history} forecast={charts.overall.fc} unit="months" />
            </Card>

            <div className="fc-duo">
              <Card title="Forecast by crime head" subtitle={accuracyNote(fc.crimehead.quality)}>
                <select className="cf-select fc-select" value={head} onChange={(e) => setHead(e.target.value)}>
                  {heads.map((h) => <option key={h.key} value={h.key}>{h.label}</option>)}
                </select>
                {charts.byHead
                  ? <ForecastChart history={charts.byHead.history} forecast={charts.byHead.fc} height={300} unit="months" />
                  : <div className="rp-empty">No forecast for this crime head.</div>}
              </Card>

              <Card title="Forecast by district" subtitle={accuracyNote(fc.district.quality)}>
                <select className="cf-select fc-select" value={district} onChange={(e) => setDistrict(e.target.value)}>
                  {districts.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
                {charts.byDistrict
                  ? <ForecastChart history={charts.byDistrict.history} forecast={charts.byDistrict.fc} height={300} unit="months" />
                  : <div className="rp-empty">No forecast for this district.</div>}
              </Card>
            </div>
          </>
        )}

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
      </div>
    </>
  );
}
