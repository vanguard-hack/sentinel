import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  RefreshCw, AlertTriangle,
  Brain, TrendingUp, TrendingDown, Lightbulb, Activity, Share2, LineChart, Fingerprint, Landmark,
} from 'lucide-react';
import {
  getIncidents, refreshIncidents, hourlyProfile, dayOfMonthProfile, weekdayProfile,
  peakWindow, monthlySeries, forecastMonths, headDaypartMatrix, DAYPARTS,
} from '../utils/aianalytics';
import TrendArea from '../components/charts/TrendArea';
import BarList from '../components/charts/BarColumns';
import CrimeLinks from '../components/CrimeLinks';
import CaseLinkage from '../components/CaseLinkage';
import Forecasts from '../components/Forecasts';
import FinancialTrails from '../components/FinancialTrails';
import TopBar from '../components/TopBar';
import { useLocation } from 'react-router-dom';

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

/* A kept-but-hidden tab.
   Declared at module scope on purpose: a component defined inside the page
   body is a NEW component type on every render, so React would unmount and
   remount the whole tab each time — which is exactly the cost this is here to
   avoid. */
const Pane = ({ hidden, children }) => <div hidden={hidden}>{children}</div>;

const DIMENSIONS = [
  { key: 'hour', label: 'Hour of day' },
  { key: 'dom', label: 'Day of month' },
  { key: 'dow', label: 'Day of week' },
];

const pad2 = (n) => String(n).padStart(2, '0');

export default function AIAnalytics() {
  const [data, setData] = useState(null); // { incidents, headNames }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dim, setDim] = useState('hour');
  const [head, setHead] = useState('ALL');
  const [view, setView] = useState('patterns'); // 'patterns' | 'links' | 'linkage' | 'forecasts' | 'financial'

  // Honor deep-links from the global search (e.g. /ai-analytics?tab=financial).
  const { search } = useLocation();
  useEffect(() => {
    const tab = new URLSearchParams(search).get('tab');
    if (tab && ['patterns', 'links', 'linkage', 'forecasts', 'financial'].includes(tab)) {
      setView(tab);
    }
  }, [search]);

  const load = useCallback(async (rebuild = false) => {
    if (rebuild) refreshIncidents();
    setLoading(true);
    setError(null);
    try {
      setData(await getIncidents());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    return head === 'ALL' ? data.incidents : data.incidents.filter((r) => r.head === head);
  }, [data, head]);

  // Temporal profile for the selected dimension + peak-window callout.
  const profile = useMemo(() => {
    if (!filtered.length) return null;
    if (dim === 'hour') {
      const p = hourlyProfile(filtered);
      const w = peakWindow(p, 4);
      return {
        data: p,
        chart: 'area',
        peak: `Peak window ${pad2(w.start)}:00–${pad2(w.end)}:00 — ${w.count.toLocaleString()} incidents (${w.share.toFixed(0)}% of total)`,
      };
    }
    if (dim === 'dom') {
      const p = dayOfMonthProfile(filtered);
      const w = peakWindow(p, 5);
      return {
        data: p,
        chart: 'area',
        peak: `Busiest stretch: days ${w.start + 1}–${((w.end - 1 + 31) % 31) + 1} of the month — ${w.count.toLocaleString()} incidents (${w.share.toFixed(0)}%)`,
      };
    }
    const p = weekdayProfile(filtered);
    const top = [...p].sort((a, b) => b.value - a.value)[0];
    return {
      data: p,
      chart: 'bars',
      peak: `Busiest day: ${top.label} — ${top.value.toLocaleString()} incidents`,
    };
  }, [filtered, dim]);

  // Forecast from the full (unfiltered-by-time) monthly series of the current
  // head selection.
  const fc = useMemo(() => {
    if (!filtered.length) return null;
    const series = monthlySeries(filtered);
    const { points, slope } = forecastMonths(series);
    return {
      chartData: [...series.slice(-12), ...points],
      points,
      slope,
    };
  }, [filtered]);

  const matrix = useMemo(
    () => (data ? headDaypartMatrix(data.incidents, data.headNames) : []),
    [data]
  );
  const matrixMax = Math.max(1, ...matrix.flatMap((r) => r.cells));

  const insights = useMemo(() => {
    if (!data || !filtered.length || !fc) return [];
    const out = [];
    const hp = hourlyProfile(filtered);
    const hw = peakWindow(hp, 4);
    out.push(
      `${hw.share.toFixed(0)}% of incidents occur between ${pad2(hw.start)}:00 and ${pad2(hw.end)}:00 — the highest-risk patrol window.`
    );
    const wp = weekdayProfile(filtered);
    const topDay = [...wp].sort((a, b) => b.value - a.value)[0];
    out.push(`${topDay.label} is the busiest day of the week (${topDay.value.toLocaleString()} incidents).`);
    if (fc.points.length) {
      const dir = fc.slope >= 0 ? 'rising' : 'falling';
      out.push(
        `Registrations are ${dir} by ~${Math.abs(fc.slope).toFixed(1)} cases/month; next month is projected at ${fc.points[0].value.toLocaleString()} cases.`
      );
    }
    if (head === 'ALL' && matrix.length) {
      const nocturnal = [...matrix]
        .filter((r) => r.total >= 30)
        .sort((a, b) => b.cells[0] / b.total - a.cells[0] / a.total)[0];
      if (nocturnal) {
        out.push(
          `${nocturnal.head} is the most nocturnal category — ${Math.round((nocturnal.cells[0] / nocturnal.total) * 100)}% of its incidents happen between 00:00 and 06:00.`
        );
      }
    }
    return out;
  }, [data, filtered, fc, matrix, head]);

  const headOptions = data
    ? Object.entries(data.headNames).sort((a, b) => Number(a[0]) - Number(b[0]))
    : [];

  /* Tabs are mounted on first visit and then KEPT, hidden rather than
     unmounted.
     Unmounting threw away every filter, every page position and every derived
     view the officer had set up, and made coming back cost a full rebuild —
     the models are cached now, but a remount still re-renders thousands of
     table rows and re-fits a canvas. Mounting lazily is what keeps the first
     paint cheap: an unvisited tab costs nothing at all.
     `hidden` is a real attribute, so a hidden tab is out of the accessibility
     tree and out of tab order — it is not merely painted over. */
  const [visited, setVisited] = useState(() => new Set(['patterns']));
  useEffect(() => { setVisited((v) => (v.has(view) ? v : new Set(v).add(view))); }, [view]);
  const pane = (tab, node) => (visited.has(tab) ? <Pane hidden={view !== tab}>{node}</Pane> : null);

  return (
    <div className="rp-page">
      <TopBar title="AI Analytics" subtitle="Temporal patterns & criminal networks">
        <button className="cf-icon-btn" onClick={() => load(true)} title="Refresh" disabled={loading}>
          <RefreshCw size={15} className={loading ? 'cf-spin' : ''} />
        </button>
      </TopBar>

      <main className="rp-main">
        <div className="ai-viewtabs" role="tablist" aria-label="Analytics view">
          <button
            className={`ai-viewtab ${view === 'patterns' ? 'active' : ''}`}
            onClick={() => setView('patterns')}
            role="tab" aria-selected={view === 'patterns'}
          >
            <Activity size={15} /> Temporal patterns
          </button>
          <button
            className={`ai-viewtab ${view === 'links' ? 'active' : ''}`}
            onClick={() => setView('links')}
            role="tab" aria-selected={view === 'links'}
          >
            <Share2 size={15} /> Crime links
          </button>
          <button
            className={`ai-viewtab ${view === 'linkage' ? 'active' : ''}`}
            onClick={() => setView('linkage')}
            role="tab" aria-selected={view === 'linkage'}
          >
            <Fingerprint size={15} /> Case linkage
          </button>
          <button
            className={`ai-viewtab ${view === 'forecasts' ? 'active' : ''}`}
            onClick={() => setView('forecasts')}
            role="tab" aria-selected={view === 'forecasts'}
          >
            <LineChart size={15} /> Forecasts
          </button>
          <button
            className={`ai-viewtab ${view === 'financial' ? 'active' : ''}`}
            onClick={() => setView('financial')}
            role="tab" aria-selected={view === 'financial'}
          >
            <Landmark size={15} /> Financial trails
          </button>
        </div>

        {pane('financial', <FinancialTrails />)}
        {pane('forecasts', <Forecasts />)}
        {pane('links', <CrimeLinks />)}
        {pane('linkage', <CaseLinkage />)}

        {view !== 'patterns' ? null : error ? (
          <div className="cf-state cf-error">
            <AlertTriangle size={22} />
            <p>{error}</p>
            <button className="cf-retry" onClick={load}>Retry</button>
          </div>
        ) : loading || !data ? (
          <div className="cf-state">
            <div className="cf-spinner" />
            <p>Mining incident patterns…</p>
          </div>
        ) : (
          <>
            {/* Controls: dimension toggle + crime-head filter */}
            <div className="ai-controls">
              <div className="ai-seg" role="group" aria-label="Time dimension">
                {DIMENSIONS.map(({ key, label }) => (
                  <button
                    key={key}
                    className={`ai-seg-btn ${dim === key ? 'active' : ''}`}
                    onClick={() => setDim(key)}
                    aria-pressed={dim === key}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <select
                className="cf-select"
                value={head}
                onChange={(e) => setHead(e.target.value)}
                title="Filter by crime head"
              >
                <option value="ALL">All crime heads</option>
                {headOptions.map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
              <span className="ai-sample">
                {filtered.length.toLocaleString()} incidents analysed
              </span>
            </div>

            <div className="rp-grid">
              <Card
                title={`Incidents by ${DIMENSIONS.find((d) => d.key === dim).label.toLowerCase()}`}
                subtitle={profile?.peak}
                wide
              >
                {profile && profile.chart === 'area' ? (
                  <TrendArea data={profile.data} height={170} />
                ) : profile ? (
                  <BarList
                    data={dim === 'dow'
                      ? profile.data.map((d) => ({ ...d, label: d.label.slice(0, 3) }))
                      : profile.data}
                    straightLabels
                  />
                ) : (
                  <div className="rp-empty">No incidents match this filter</div>
                )}
              </Card>

              <Card
                title="Registration forecast"
                subtitle="Monthly cases, last 12 observed + 3 projected (dashed) — linear trend, not a trained model"
              >
                {fc && fc.chartData.length > 4 ? (
                  <>
                    <TrendArea data={fc.chartData} height={160} />
                    <p className={`ai-fc-note ${fc.slope >= 0 ? 'up' : 'down'}`}>
                      {fc.slope >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                      Trend {fc.slope >= 0 ? '+' : '−'}{Math.abs(fc.slope).toFixed(1)} cases/month
                    </p>
                  </>
                ) : (
                  <div className="rp-empty">Not enough history to project</div>
                )}
              </Card>

              <Card
                title="Patrol insights"
                subtitle="Auto-derived from the incident data and the current filter"
              >
                <ul className="ai-insights">
                  {insights.map((s, i) => (
                    <li key={i}>
                      <Lightbulb size={14} />
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card
                title="Crime head × time of day"
                subtitle="Incident intensity per daypart — darker means more incidents"
                wide
              >
                <div className="cf-scroll">
                  <table className="ai-matrix">
                    <thead>
                      <tr>
                        <th>Crime head</th>
                        {DAYPARTS.map((p) => <th key={p.label}>{p.label}</th>)}
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matrix.map((row) => (
                        <tr key={row.head}>
                          <td className="ai-matrix-head">{row.head}</td>
                          {row.cells.map((v, i) => (
                            <td key={i}>
                              <span
                                className="ai-cell"
                                style={{ '--heat': (v / matrixMax).toFixed(3) }}
                                title={`${row.head} · ${DAYPARTS[i].label}: ${v}`}
                              >
                                {v}
                              </span>
                            </td>
                          ))}
                          <td className="ai-matrix-total">{row.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>

            <p className="rp-footnote">
              <Brain size={13} /> Patterns computed live from incident timestamps in the Data
              Store. The forecast is a transparent linear-trend projection — indicative, not
              predictive policing.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
