import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  RefreshCw, AlertTriangle, CalendarDays, ChevronDown,
  FileText, Users, HeartPulse, PackageCheck, FolderOpen, Gavel,
  Flame, Siren, TrendingUp, TrendingDown, FileDown,
} from 'lucide-react';
import { fetchReports, buildTrend, TREND_RANGES } from '../utils/reports';
import { exportReportPdf } from '../utils/reportPdf';
import { BarList, Donut, TrendArea } from '../components/Charts';
import SocioCrimeMap from '../components/SocioCrimeMap';
import TopBar from '../components/TopBar';
import { useAuth } from '../context/AuthContext';

function Kpi({ Icon, label, value, sub, trend }) {
  return (
    <div className="rp-kpi">
      <div className="rp-kpi-icon"><Icon size={18} strokeWidth={1.7} /></div>
      <div className="rp-kpi-body">
        <span className="rp-kpi-value">{value}</span>
        <span className="rp-kpi-label">{label}</span>
        {sub && (
          <span className={`rp-kpi-sub ${trend ? `db-trend-${trend}` : ''}`}>
            {trend === 'up' && <TrendingUp size={11} />}
            {trend === 'down' && <TrendingDown size={11} />}
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

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

export default function Reports() {
  const { user } = useAuth();
  const firstName =
    user?.first_name || user?.email_id?.split('@')[0] || 'Officer';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState(null);
  const [trendRange, setTrendRange] = useState('month');
  const contentRef = useRef(null);

  const exportPdf = useCallback(async () => {
    if (!data || pdfBusy) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      await exportReportPdf(contentRef.current);
    } catch (e) {
      setPdfError(e.message || String(e));
    } finally {
      setPdfBusy(false);
    }
  }, [data, pdfBusy]);

  const trendSeries = useMemo(
    () => (data?.caseDates ? buildTrend(data.caseDates, trendRange) : []),
    [data, trendRange]
  );
  const trendLabelEvery = trendRange === 'day' ? 5 : trendRange === 'year' ? 4 : 1;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchReports());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="rp-page">
      <TopBar title="Home" subtitle="Crime statistics & trends" />

      <main className="rp-main">
        {/* Welcome hero + time filter cluster */}
        <div className="rp-hero">
          <div className="rp-hero-text">
            <h1 className="rp-hero-title">
              Welcome Back, <span className="rp-hero-name">{firstName}</span>
            </h1>
            <p className="rp-hero-sub">Here’s the latest crime overview.</p>
          </div>
          <div className="rp-hero-controls">
            <label className="rp-range" title="Trend granularity">
              <CalendarDays size={15} className="rp-range-icon" />
              <select value={trendRange} onChange={(e) => setTrendRange(e.target.value)}>
                {TREND_RANGES.map((r) => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
              <ChevronDown size={15} className="rp-range-caret" />
            </label>
            <button
              className="cf-export-btn"
              onClick={exportPdf}
              disabled={pdfBusy || loading || !data}
              title={pdfError ? `Last attempt failed: ${pdfError}` : 'Download this report as PDF'}
            >
              {pdfBusy ? <span className="btn-spinner" /> : <FileDown size={15} />}
              <span>{pdfBusy ? 'Exporting' : pdfError ? 'Retry PDF' : 'Export'}</span>
            </button>
            <button className="cf-icon-btn" onClick={load} title="Refresh" disabled={loading}>
              <RefreshCw size={15} className={loading ? 'cf-spin' : ''} />
            </button>
          </div>
        </div>

        {error ? (
          <div className="cf-state cf-error">
            <AlertTriangle size={22} />
            <p>{error}</p>
            <button className="cf-retry" onClick={load}>Retry</button>
          </div>
        ) : loading || !data ? (
          <div className="cf-state">
            <div className="cf-spinner" />
            <p>Crunching the numbers…</p>
          </div>
        ) : (
          <div ref={contentRef}>
            {/* KPI tiles */}
            <div className="rp-kpi-row">
              <Kpi
                Icon={FileText}
                label="FIRs registered"
                value={data.kpis.firs.toLocaleString()}
                sub={
                  data.kpis.yoyPct == null
                    ? `${data.kpis.thisYear.toLocaleString()} this year`
                    : `${Math.abs(data.kpis.yoyPct).toFixed(0)}% YoY (same period)`
                }
                trend={data.kpis.yoyPct == null ? null : data.kpis.yoyPct >= 0 ? 'up' : 'down'}
              />
              <Kpi
                Icon={FolderOpen}
                label="Open investigations"
                value={data.kpis.open.toLocaleString()}
                sub={`${data.kpis.openPct.toFixed(1)}% of all cases`}
              />
              <Kpi
                Icon={Gavel}
                label="Solved rate"
                value={`${data.kpis.solvedPct.toFixed(1)}%`}
                sub="chargesheeted, on trial or decided"
              />
              <Kpi
                Icon={Flame}
                label="Heinous share"
                value={`${data.kpis.heinousPct.toFixed(1)}%`}
                sub="of registered cases"
              />
              <Kpi Icon={Users} label="Accused on record" value={data.kpis.accused.toLocaleString()} />
              <Kpi Icon={HeartPulse} label="Victims recorded" value={data.kpis.victims.toLocaleString()} />
              <Kpi
                Icon={Siren}
                label="Arrests & surrenders"
                value={data.kpis.arrests.toLocaleString()}
              />
              <Kpi
                Icon={PackageCheck}
                label="Chargesheet rate"
                value={`${data.kpis.chargesheetPct.toFixed(1)}%`}
                sub={`${data.kpis.chargesheets.toLocaleString()} of ${data.kpis.firs.toLocaleString()} cases`}
              />
            </div>

            {/* Crime trend with day/month/year/5-year filter */}
            <section className="rp-card rp-card-wide">
              <div className="rp-card-head">
                <h2>Crime trend</h2>
                <span className="rp-card-sub">
                  {TREND_RANGES.find((r) => r.key === trendRange)?.label} · cases registered
                </span>
              </div>
              <div className="rp-card-body">
                <TrendArea data={trendSeries} labelEvery={trendLabelEvery} height={180} />
              </div>
            </section>

            {/* Charts */}
            <div className="rp-grid">
              <Card title="Crimes per year" subtitle="Total cases registered each year">
                <TrendArea data={data.yearly} />
              </Card>

              <Card title="Case status" subtitle="Distribution of FIR outcomes">
                <Donut data={data.byStatus} />
              </Card>

              <Card title="Crime by category" subtitle="FIR classifications by major head">
                <BarList data={data.byCategory} />
              </Card>

              <Card title="Top districts" subtitle="FIRs registered per district">
                <BarList data={data.byDistrict} />
              </Card>

              <Card title="Station load" subtitle="Open investigations by police station (top 8)">
                <BarList data={data.openByStation} />
              </Card>

              <Card title="Accused age profile" subtitle="Accused on record by age band">
                <BarList data={data.accusedAges} />
              </Card>

              <Card title="Top crime types" subtitle="Cases by crime sub-head">
                <BarList data={data.bySubHead} />
              </Card>

              <Card
                title="Socio-economic crime correlation"
                subtitle="Districts shaded by the chosen indicator; circles sized by registered cases — when dark shading and big circles coincide, the two move together"
                wide
              >
                <SocioCrimeMap crimeByDistrict={data.crimeByDistrict} />
              </Card>
            </div>

            <p className="rp-footnote">
              Live from the Data Store via ZCQL aggregates over the Police FIR schema.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
