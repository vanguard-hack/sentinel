import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  RefreshCw, AlertTriangle, CalendarDays, ChevronDown,
  FileText, Users, HeartPulse, PackageCheck, FolderOpen, Gavel,
  Flame, Siren, FileDown, Database,
} from 'lucide-react';
import { fetchReports, computeReport, trendSeries, earliestTs, TREND_RANGES, customLabel } from '../utils/reports';
import { exportHomeReportPdf } from '../utils/reportPdf';
import DateRangeCalendar from '../components/DateRangeCalendar';
import { HeatGrid, Funnel, Pyramid } from '../components/Charts';
// The vendored Bklit chart set. Everything still imported from Charts.js above
// is a shape Bklit has no equivalent for, or one not yet converted.
import TrendLine from '../components/charts/TrendLine';
import TrendArea from '../components/charts/TrendArea';
import BarList from '../components/charts/BarColumns';
import HBarList from '../components/charts/BarRows';
import Donut from '../components/charts/Ring';
import StatTile from '../components/charts/StatTile';
import SocioCrimeMap from '../components/SocioCrimeMap';
import Sankey from '../components/Sankey';
import GeoHeatMap from '../components/GeoHeatMap';
import TopBar from '../components/TopBar';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';

function Card({ id, title, subtitle, wide, two, hero, tall, section, children }) {
  const span = [
    hero && 'rp-card-hero',
    tall && 'rp-card-tall',
    !hero && wide && 'rp-card-wide',
    !hero && two && 'rp-card-2',
  ].filter(Boolean).join(' ');
  return (
    // data-pdf-section groups cards into titled, one-page-per-section spreads
    // in the PDF export (see exportHomeReportPdf) without duplicating this
    // page's own layout — the bento above is deliberately ONE lattice with no
    // section walls; the PDF is the one place sections still make sense.
    <section id={id} className={`rp-card ${span}`} data-pdf-section={section}>
      <div className="rp-card-head">
        <h2>{title}</h2>
        {subtitle && <span className="rp-card-sub">{subtitle}</span>}
      </div>
      <div className="rp-card-body">{children}</div>
    </section>
  );
}

export default function Reports() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const firstName =
    user?.first_name || user?.email_id?.split('@')[0] || 'Officer';
  const [bundle, setBundle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState(null);
  const [trendRange, setTrendRange] = useState('year');
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
      await exportHomeReportPdf(contentRef.current, { rangeLabel: data.rangeLabel });
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
      <TopBar title={t('pages.home')} subtitle={t('pages.homeSub')} />

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
                      {ddmmyyyy(draftTo) || 'To'}
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
              onClick={() => exportPdf()}
              disabled={pdfBusy || loading || !data}
              title={pdfError ? `Last attempt failed: ${pdfError}` : 'Download this report as PDF'}
            >
              {pdfBusy ? <span className="btn-spinner" /> : <FileDown size={15} />}
              <span>{pdfBusy ? 'Exporting' : pdfError ? 'Retry PDF' : 'Export'}</span>
            </button>
            <button className="cf-icon-btn" onClick={load} title={t('charts.refresh')} disabled={loading}>
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
            <div className="rp-kpi-row" data-pdf-section="Overview">
              <StatTile
                Icon={FileText}
                label="FIRs registered"
                value={data.kpis.firs}
                sub={data.kpis.deltaPct == null ? data.rangeLabel : undefined}
                trend={data.kpis.deltaPct == null ? null : {
                  dir: data.kpis.deltaPct >= 0 ? 'up' : 'down',
                  text: `${Math.abs(data.kpis.deltaPct).toFixed(0)}%`,
                }}
              />
              <StatTile
                Icon={FolderOpen}
                label="Open investigations"
                value={data.kpis.open}
                share={data.kpis.openPct}
                sub={`${data.kpis.openPct.toFixed(1)}% of all cases`}
              />
              <StatTile
                Icon={Gavel}
                label="Solved rate"
                value={data.kpis.solvedPct}
                format={(v) => `${v.toFixed(1)}%`}
                share={data.kpis.solvedPct}
                sub="chargesheeted, on trial or decided"
              />
              <StatTile
                Icon={Flame}
                label="Heinous share"
                value={data.kpis.heinousPct}
                format={(v) => `${v.toFixed(1)}%`}
                share={data.kpis.heinousPct}
                sub="of registered cases"
              />
              <StatTile Icon={Users} label="Accused on record" value={data.kpis.accused} />
              <StatTile Icon={HeartPulse} label="Victims recorded" value={data.kpis.victims} />
              <StatTile Icon={Siren} label="Arrests & surrenders" value={data.kpis.arrests} />
              <StatTile
                Icon={PackageCheck}
                label="Chargesheet rate"
                value={data.kpis.chargesheetPct}
                format={(v) => `${v.toFixed(1)}%`}
                share={data.kpis.chargesheetPct}
                sub={`${data.kpis.chargesheets.toLocaleString()} of ${data.kpis.firs.toLocaleString()}`}
              />
            </div>

            {/* Crime trend with day/month/year/5-year filter */}
            <section id="chart-crime-trend" className="rp-card rp-standalone rp-headline" data-pdf-section="Overview">
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
                  <TrendLine
                    series={chartData.series}
                    height={340}
                    ariaLabel={`Crime trend by year, ${fmtTs(chartWin.from)} to ${fmtTs(chartWin.to)}`}
                  />
                ) : (
                  <TrendArea data={chartData?.points || []} height={320} ariaLabel="Crime trend" />
                )}
              </div>
            </section>

            {/* ── The bento ───────────────────────────────────────────────
                ONE grid, not six. The page used to be six section-headed
                grids, and a heading is a wall: a card could only ever be
                placed among its own section's cards, so every section ended
                on a ragged row and the page read as a column of half-empty
                shelves.

                With the walls gone the whole page is one lattice and the
                cards are ordered into BANDS that each fill the four columns
                exactly:

                  hero + tall + tall            2 rows   ██████░░░░
                  hero + wide over wide         2 rows
                  hero + wide + one + one       2 rows
                  tall + tall + wide over wide  2 rows
                  tall + tall + four ones       2 rows
                  wide + one + one              1 row

                Every span is 1 or 2 columns wide, so the same bands re-pack
                without holes when the grid drops to two columns, and to one
                on a phone. The order below IS the layout — moving a card
                between bands breaks the tiling, so keep the band comments. */}
            <div className="rp-grid rp-bento">
              {/* Band 1 — the map, flanked by two ranked lists. */}
              <Card id="chart-top-districts" title={t('charts.topDistricts')} subtitle={t('charts.topDistrictsSub')} hero section="Geography & caseload">
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
              <Card id="chart-crime-category" title={t('charts.crimeCategory')} subtitle={t('charts.crimeCategorySub')} tall section="Geography & caseload">
                <HBarList data={data.byCategory} />
              </Card>
              <Card id="chart-station-load" title="Station load" subtitle="Open investigations by police station (top 8)" tall section="Geography & caseload">
                <HBarList data={data.openByStation} />
              </Card>

              {/* Band 2 — the flow, with two time series stacked beside it. */}
              <Card
                id="chart-crime-types"
                title="Crime flow"
                subtitle="Category → type → outcome · ribbon width is case volume" hero section="Case flow & time trends">
                <Sankey spec={data.crimeSankey} />
              </Card>
              <Card id="chart-age-profile" title="Accused age profile" subtitle="Accused on record by age band" wide section="Case flow & time trends">
                <BarList data={data.accusedAges} height={300} />
              </Card>
              <Card id="chart-arrests" title="Arrests & surrenders" subtitle="Monthly events by type" wide section="Case flow & time trends">
                <TrendLine series={data.arrestSeries} height={250} ariaLabel="Arrests and surrenders" />
              </Card>

              {/* Band 3 — the second map, then the seasonality strip over two rings. */}
              <Card
                id="chart-socio"
                title="Socio-economic correlation"
                subtitle="Districts shaded by indicator, circles sized by cases" hero section="Socio-economic & seasonality">
                <SocioCrimeMap crimeByDistrict={data.crimeByDistrict} />
              </Card>
              <Card title="Seasonality" subtitle="Registrations by calendar month × crime head" wide section="Socio-economic & seasonality">
                <HeatGrid rows={data.seasonality.rows} cols={data.seasonality.cols} values={data.seasonality.values} />
              </Card>
              <Card id="chart-case-status" title={t('charts.caseStatus')} subtitle={t('charts.caseStatusSub')} section="Socio-economic & seasonality">
                <Donut data={data.byStatus} />
              </Card>
              <Card title="Heinous vs non-heinous" subtitle="Gravity of registered offences" section="Socio-economic & seasonality">
                <Donut data={data.gravitySplit} />
              </Card>

              {/* Band 4 — the trend, flanked by two legal lists. */}
              <Card id="chart-trend-head" title="Crime trend by head" subtitle="Monthly registrations · top 5 crime heads" hero section="Legal trends & investigation time">
                <TrendLine series={data.trendByHead} height={250} ariaLabel="Crime trend by head" />
              </Card>
              <Card title="Most-charged sections" subtitle="Top legal sections across charged cases" tall section="Legal trends & investigation time">
                <HBarList data={data.topSections} />
              </Card>
              <Card title="Investigation time by head" subtitle="Average days to chargesheet per crime head" tall section="Legal trends & investigation time">
                <HBarList data={data.investTimeByHead} suffix=" days" percent={false} />
              </Card>

              {/* Band 5 — two lists about people, two distributions beside them. */}
              <Card title="Complainant occupations" subtitle="Who is filing FIRs" tall section="People">
                <HBarList data={data.complainantOccupations} />
              </Card>
              <Card title="Repeat offenders" subtitle="Distinct FIRs per offender (2+ cases)" tall section="People">
                <HBarList data={data.repeatOffenders} suffix=" FIRs" percent={false} />
              </Card>
              <Card title="Complainant age profile" subtitle="Complainants by age band" wide section="People">
                <BarList data={data.complainantAges} height={300} />
              </Card>
              <Card title="Chargesheet filing lag" subtitle="Days from registration to chargesheet" wide section="People">
                <BarList data={data.csLag} height={300} straightLabels caption={false} />
              </Card>

              {/* Band 6 — two workload lists, and the four small shapes. */}
              <Card title="IO caseload" subtitle="Cases per investigating officer (top 8)" tall section="Workload & case outcomes">
                <HBarList data={data.ioCaseload} />
              </Card>
              <Card title="Court load" subtitle="Chargesheets filed per court (top 8)" tall section="Workload & case outcomes">
                <HBarList data={data.courtLoad} />
              </Card>
              <Card title="Case category" subtitle="FIR · UDR · PAR · Zero FIR" section="Workload & case outcomes">
                <Donut data={data.categorySplit} />
              </Card>
              <Card title="Case status funnel" subtitle="Registered → chargesheeted → decided" section="Workload & case outcomes">
                <Funnel data={data.statusFunnel} />
              </Card>
              <Card title="Pendency ageing" subtitle="Open cases by age · green fresh, red long-pending" section="Workload & case outcomes">
                <Pyramid data={data.pendencyAgeing} />
              </Card>
              <Card title="Accused gender split" subtitle="Accused on record" section="Workload & case outcomes">
                <Donut data={data.accusedGender} />
              </Card>

              {/* Band 7 — the closing row. Rank distribution takes the wide
                  slot because its legend is a twelve-rank ladder. */}
              <Card title="Rank distribution" subtitle="Force composition by rank" wide section="Force composition">
                <Donut data={data.rankDistribution} />
              </Card>
              <Card title="Victim profile" subtitle="Police personnel vs civilian victims" section="Force composition">
                <Donut data={data.victimPoliceSplit} />
              </Card>
              <Card title="Arrest outcome" subtitle="Arrests vs surrenders" section="Force composition">
                <Donut data={data.arrestOutcome} />
              </Card>
            </div>

            <p className="rp-footnote">
              <Database size={13} /> Every figure above is computed live from the synthetic
              Karnataka FIR dataset in the Catalyst Data Store, for {data.rangeLabel}. Synthetic
              hackathon data — no real citizen records. Advisory only; verify before acting.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
