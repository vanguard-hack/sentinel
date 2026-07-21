import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  RefreshCw, AlertTriangle, CalendarDays, ChevronDown,
  FileText, Users, HeartPulse, PackageCheck, FolderOpen, Gavel,
  Flame, Siren, TrendingUp, TrendingDown, FileDown,
} from 'lucide-react';
import { fetchReports, computeReport, trendSeries, earliestTs, TREND_RANGES, customLabel } from '../utils/reports';
import { exportReportPdf } from '../utils/reportPdf';
import DateRangeCalendar from '../components/DateRangeCalendar';
import { BarList, HBarList, Donut, TrendArea, MultiLine, HeatGrid, Funnel, Pyramid } from '../components/Charts';
import SocioCrimeMap from '../components/SocioCrimeMap';
import GeoHeatMap from '../components/GeoHeatMap';
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

function Card({ title, subtitle, wide, two, children }) {
  return (
    <section className={`rp-card ${wide ? 'rp-card-wide' : ''} ${two ? 'rp-card-2' : ''}`}>
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
  const [bundle, setBundle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState(null);
  const [trendRange, setTrendRange] = useState('month');
  const contentRef = useRef(null);

  // Custom date range: null = use the preset; { from, to } (YYYY-MM-DD,
  // inclusive) overrides it for every KPI and chart.
  const [customRange, setCustomRange] = useState(null);
  const [calOpen, setCalOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const calRef = useRef(null);

  useEffect(() => {
    if (!calOpen) return undefined;
    const onDown = (e) => {
      if (calRef.current && !calRef.current.contains(e.target)) setCalOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setCalOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [calOpen]);

  const openCal = () => {
    // Prefill with the active custom range; otherwise start empty.
    setDraftFrom(customRange?.from || '');
    setDraftTo(customRange?.to || '');
    setCalOpen((o) => !o);
  };
  const draftValid = draftFrom && draftTo && draftFrom <= draftTo;
  const ddmmyyyy = (iso) =>
    iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';

  // The selected range filters every KPI and chart, computed client-side.
  const data = useMemo(
    () => (bundle ? computeReport(bundle.raw, bundle.masters, trendRange, customRange) : null),
    [bundle, trendRange, customRange]
  );

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

  const [topK, setTopK] = useState(10); // districts shown on the geo heatmap

  // ── Crime-trend chart: its own window, independent of the global filter ──
  const [chartPreset, setChartPreset] = useState('ALL');
  const [chartCustom, setChartCustom] = useState(null);
  const [chartCalOpen, setChartCalOpen] = useState(false);
  const [chartFrom, setChartFrom] = useState('');
  const [chartTo, setChartTo] = useState('');
  const chartCalRef = useRef(null);

  useEffect(() => {
    if (!chartCalOpen) return undefined;
    const onDown = (e) => {
      if (chartCalRef.current && !chartCalRef.current.contains(e.target)) setChartCalOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setChartCalOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [chartCalOpen]);

  const chartWin = useMemo(() => {
    const now = Date.now();
    if (chartCustom) {
      return {
        from: Date.parse(chartCustom.from + 'T00:00:00Z'),
        to: Date.parse(chartCustom.to + 'T00:00:00Z') + 86399999,
      };
    }
    switch (chartPreset) {
      case '1M': return { from: now - 30 * 86400000, to: now };
      case '6M': return { from: now - 183 * 86400000, to: now };
      case 'YTD': return { from: Date.UTC(new Date().getUTCFullYear(), 0, 1), to: now };
      case '1Y': return { from: now - 365 * 86400000, to: now };
      default: return { from: bundle ? earliestTs(bundle.raw.caseDates) : now, to: now };
    }
  }, [chartPreset, chartCustom, bundle]);

  const chartData = useMemo(
    () => (bundle ? trendSeries(bundle.raw.caseDates, chartWin.from, chartWin.to) : null),
    [bundle, chartWin]
  );
  const chartLabelEvery = chartData && !chartData.multi
    ? Math.max(1, Math.ceil(chartData.points.length / 13))
    : 1;
  const fmtTs = (ts) =>
    new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBundle(await fetchReports());
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
            {/* div, not label: a label-wrapped select can open-and-instantly-
                close its dropdown in Chrome, making it unswitchable. The
                select is the full clickable surface; icons are decorative. */}
            <div className="rp-range" title="Trend granularity">
              <CalendarDays size={15} className="rp-range-icon" />
              <select
                value={customRange ? '' : trendRange}
                onChange={(e) => { setCustomRange(null); setTrendRange(e.target.value); }}
              >
                {customRange && <option value="">Custom</option>}
                {TREND_RANGES.map((r) => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
              <ChevronDown size={15} className="rp-range-caret" />
            </div>

            {/* Custom date-range picker */}
            <div className="rp-cal" ref={calRef}>
              <button
                className={`cf-icon-btn rp-cal-btn ${customRange ? 'active' : ''}`}
                onClick={openCal}
                title="Pick a custom date range"
                aria-haspopup="dialog"
                aria-expanded={calOpen}
              >
                <CalendarDays size={15} />
                {customRange && <span className="rp-cal-label">{customLabel(customRange)}</span>}
              </button>

              {calOpen && (
                <div className="rp-cal-pop" role="dialog" aria-label="Custom date range">
                  <div className="rp-cal-inputs">
                    <span className={`rp-cal-field ${draftFrom ? '' : 'placeholder'}`}>
                      {ddmmyyyy(draftFrom) || 'From'}
                    </span>
                    <span className={`rp-cal-field ${draftTo ? '' : 'placeholder'}`}>
                      {ddmmyyyy(draftTo) || 'dd/mm/yyyy'}
                    </span>
                  </div>

                  <DateRangeCalendar
                    from={draftFrom}
                    to={draftTo}
                    onSelect={(f, t) => { setDraftFrom(f); setDraftTo(t); }}
                  />

                  <div className="rp-cal-actions">
                    <button
                      className="rp-cal-clear"
                      onClick={() => {
                        setDraftFrom('');
                        setDraftTo('');
                        if (customRange) setCustomRange(null);
                      }}
                    >
                      Clear
                    </button>
                    <button
                      className="rp-cal-apply"
                      disabled={!draftValid}
                      onClick={() => {
                        setCustomRange({ from: draftFrom, to: draftTo });
                        setCalOpen(false);
                      }}
                    >
                      Apply
                    </button>
                  </div>
                </div>
              )}
            </div>
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
                  data.kpis.deltaPct == null
                    ? data.rangeLabel
                    : `${Math.abs(data.kpis.deltaPct).toFixed(0)}% vs prev period`
                }
                trend={data.kpis.deltaPct == null ? null : data.kpis.deltaPct >= 0 ? 'up' : 'down'}
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
            <section className="rp-card rp-card-wide rp-standalone">
              <div className="rp-card-head rp-trend-head">
                <div>
                  <h2>Crime trend</h2>
                  <span className="rp-card-sub">{fmtTs(chartWin.from)} – {fmtTs(chartWin.to)}</span>
                </div>
                <div className="rp-trend-controls">
                  <div className="seg-group" role="tablist" aria-label="Chart range">
                    {['1M', '6M', 'YTD', '1Y', 'ALL'].map((p) => (
                      <button
                        key={p}
                        role="tab"
                        aria-selected={!chartCustom && chartPreset === p}
                        className={`seg-btn ${!chartCustom && chartPreset === p ? 'active' : ''}`}
                        onClick={() => { setChartCustom(null); setChartPreset(p); }}
                      >
                        {p === 'ALL' ? 'All' : p}
                      </button>
                    ))}
                  </div>
                  <div className="rp-cal" ref={chartCalRef}>
                    <button
                      className={`cf-icon-btn rp-cal-btn ${chartCustom ? 'active' : ''}`}
                      onClick={() => {
                        setChartFrom(chartCustom?.from || '');
                        setChartTo(chartCustom?.to || '');
                        setChartCalOpen((o) => !o);
                      }}
                      title="Custom range for this chart"
                    >
                      <CalendarDays size={15} />
                      {chartCustom && <span className="rp-cal-label">{customLabel(chartCustom)}</span>}
                    </button>
                    {chartCalOpen && (
                      <div className="rp-cal-pop" role="dialog" aria-label="Chart date range">
                        <DateRangeCalendar
                          from={chartFrom}
                          to={chartTo}
                          onSelect={(f, t) => { setChartFrom(f); setChartTo(t); }}
                        />
                        <div className="rp-cal-actions">
                          <button
                            className="rp-cal-clear"
                            onClick={() => { setChartFrom(''); setChartTo(''); if (chartCustom) setChartCustom(null); }}
                          >
                            Clear
                          </button>
                          <button
                            className="rp-cal-apply"
                            disabled={!chartFrom || !chartTo || chartFrom > chartTo}
                            onClick={() => {
                              setChartCustom({ from: chartFrom, to: chartTo });
                              setChartCalOpen(false);
                            }}
                          >
                            Apply
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="rp-card-body">
                {chartData?.multi ? (
                  <MultiLine series={chartData.series} height={340} labelEvery={1} />
                ) : (
                  <TrendArea data={chartData?.points || []} labelEvery={chartLabelEvery} height={320} />
                )}
              </div>
            </section>

            {/* Charts */}
            <div className="rp-grid">
              <Card title="Case status" subtitle="Distribution of FIR outcomes">
                <Donut data={data.byStatus} />
              </Card>

              <Card title="Crime by category" subtitle="FIR classifications by major head" two>
                <HBarList data={data.byCategory} />
              </Card>

              <Card title="Top districts" subtitle="FIRs registered per district — shading intensity follows crime volume" two>
                <div className="rp-geo-controls">
                  <span>Show top</span>
                  <select className="cf-select pp-perpage" value={topK} onChange={(e) => setTopK(e.target.value)}>
                    {[5, 10, 15, 20].map((k) => <option key={k} value={k}>{k} districts</option>)}
                    <option value="all">All districts</option>
                  </select>
                </div>
                <GeoHeatMap
                  spec={{
                    title: 'FIRs registered',
                    data: (topK === 'all' ? data.crimeByDistrict : data.crimeByDistrict.slice(0, Number(topK)))
                      .map((d) => ({ district: d.label, value: d.value })),
                  }}
                />
              </Card>

              <Card title="Station load" subtitle="Open investigations by police station (top 8)" two>
                <HBarList data={data.openByStation} />
              </Card>

              <Card title="Accused age profile" two>
                <BarList data={data.accusedAges} height={300} />
              </Card>

              <Card title="Top crime types" subtitle="Cases by crime sub-head" two>
                <HBarList data={data.bySubHead} />
              </Card>

              <Card
                title="Socio-economic crime correlation"
                subtitle="Districts shaded by the chosen indicator; circles sized by registered cases — when dark shading and big circles coincide, the two move together"
                wide
              >
                <SocioCrimeMap crimeByDistrict={data.crimeByDistrict} />
              </Card>
            </div>

            {/* ── Trends ── */}
            <h2 className="rp-section-title">Trends</h2>
            <div className="rp-grid">
              <Card title="Crime trend by head" subtitle="Monthly registrations · top 5 crime heads" wide>
                <MultiLine
                  series={data.trendByHead}
                  labelEvery={Math.max(1, Math.ceil((data.trendByHead[0]?.points.length || 1) / 14))}
                />
              </Card>
              <Card title="Arrests & surrenders" subtitle="Monthly events by type">
                <MultiLine
                  series={data.arrestSeries}
                  labelEvery={Math.max(1, Math.ceil((data.arrestSeries[0]?.points.length || 1) / 8))}
                />
              </Card>
              <Card title="Seasonality" subtitle="Registrations by calendar month × crime head" wide>
                <HeatGrid rows={data.seasonality.rows} cols={data.seasonality.cols} values={data.seasonality.values} />
              </Card>
            </div>

            {/* ── Crime composition ── */}
            <h2 className="rp-section-title">Crime composition</h2>
            <div className="rp-grid">
              <Card title="Heinous vs non-heinous" subtitle="Gravity of registered offences">
                <Donut data={data.gravitySplit} />
              </Card>
              <Card title="Case category" subtitle="FIR · UDR · PAR · Zero FIR">
                <Donut data={data.categorySplit} />
              </Card>
              <Card title="Most-charged sections" subtitle="Top legal sections across charged cases" wide>
                <HBarList data={data.topSections} />
              </Card>
            </div>

            {/* ── Case lifecycle ── */}
            <h2 className="rp-section-title">Case lifecycle</h2>
            <div className="rp-grid">
              <Card title="Case status funnel" subtitle="Registered → investigated → chargesheeted → decided">
                <Funnel data={data.statusFunnel} />
              </Card>
              <Card title="Pendency ageing" subtitle="Open investigations by age of case — green fresh, red long-pending">
                <Pyramid data={data.pendencyAgeing} />
              </Card>
              <Card title="Chargesheet filing lag" subtitle="Days from registration to chargesheet" two>
                <BarList data={data.csLag} height={300} straightLabels caption={false} />
              </Card>
              <Card title="Investigation time by head" subtitle="Average days to chargesheet per crime head" two>
                <HBarList data={data.investTimeByHead} suffix=" days" percent={false} />
              </Card>
            </div>

            {/* ── People & demographics ── */}
            <h2 className="rp-section-title">People & demographics</h2>
            <div className="rp-grid">
              <Card title="Complainant occupations" subtitle="Who is filing FIRs" two>
                <HBarList data={data.complainantOccupations} />
              </Card>
              <Card title="Complainant age profile" subtitle="Complainants by age band" two>
                <BarList data={data.complainantAges} height={300} />
              </Card>
              <Card title="Accused gender split" subtitle="Accused on record">
                <Donut data={data.accusedGender} />
              </Card>
              <Card title="Repeat offenders" subtitle="Distinct FIRs per offender (2+ cases)" two>
                <HBarList data={data.repeatOffenders} suffix=" FIRs" percent={false} />
              </Card>
              <Card title="Victim profile" subtitle="Police personnel vs civilian victims">
                <Donut data={data.victimPoliceSplit} />
              </Card>
              <Card title="Arrest outcome" subtitle="Arrests vs surrenders">
                <Donut data={data.arrestOutcome} />
              </Card>
            </div>

            {/* ── Personnel & workload ── */}
            <h2 className="rp-section-title">Personnel & workload</h2>
            <div className="rp-grid">
              <Card title="IO caseload" subtitle="Cases per investigating officer (top 8)" two>
                <HBarList data={data.ioCaseload} />
              </Card>
              <Card title="Rank distribution" subtitle="Force composition by rank">
                <Donut data={data.rankDistribution} />
              </Card>
              <Card title="Court load" subtitle="Chargesheets filed per court (top 8)" two>
                <HBarList data={data.courtLoad} />
              </Card>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
