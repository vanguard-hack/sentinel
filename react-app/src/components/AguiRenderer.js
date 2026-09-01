import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  HBarList, Donut, TrendArea, MultiLine, HeatGrid, Scatter, Funnel, Pyramid,
  StackedBars, Sankey,
} from './Charts';
import { renderCell, renderInline, normaliseText } from '../utils/richFormat';
import GeoHeatMap from './GeoHeatMap';
import NetworkGraph from './NetworkGraph';

// AG-UI-style static generative UI renderer for the assistant.
// The RAG backend proposes typed component specs; this module validates and
// renders them with app-owned components — the agent never injects markup.
//
// Supported specs (see functions/rag/index.js AGUI_INSTRUCTION):
// The vocabulary was six types for a long time, which quietly shaped what the
// assistant would answer: asked for a trend it drew a bar chart, asked for a
// composition it drew a table. A model can only propose what the renderer can
// draw, so widening this list widens the questions worth asking.
//
// Every chart below is an app-owned primitive that already existed for the
// dashboards — the assistant now reaches the same drawing code the rest of
// Sentinel uses, rather than a reduced version of it.
//
//   { type: 'bar-chart',         title, data: [{ label, value }] }
//   { type: 'pie-chart',         title, data: [{ label, value }] }
//   { type: 'line-chart',        title, data: [{ label, value }] }
//   { type: 'multi-line-chart',  title, series: [{ name, points: [{ label, value }] }] }
//   { type: 'stacked-bar-chart', title, data: [{ label, parts: [{ name, value }] }] }
//   { type: 'heat-grid',         title, rows: [str], cols: [str], values: [[n]] }
//   { type: 'scatter-plot',      title, xLabel, yLabel, data: [{ x, y, label }] }
//   { type: 'funnel',            title, data: [{ label, value }] }
//   { type: 'pyramid',           title, data: [{ label, value }] }
//   { type: 'sankey',            title, nodes: [{ id, label }], links: [{ source, target, value }] }
//   { type: 'table',             title, columns: [str], rows: [[cell, ...]] }
//   { type: 'cards',             title, items: [{ title, subtitle, body, badge }] }
//   { type: 'geo-map',           title, data: [{ district, value }] }
//   { type: 'network-graph',     title, nodes: [{ id, label, group }], links: [{ source, target }] }

/**
 * Is this a number the chart may plot?
 *
 * Number(null) is 0 and 0 is finite, so `Number.isFinite(Number(v))` quietly
 * accepts null, undefined, '' and true — and a missing figure becomes a zero
 * bar. On a police chart those are different claims: "no thefts were recorded
 * in Bagalkote" and "we do not have the Bagalkote figure" look identical once
 * drawn, and only one of them is true. This is the third place in this
 * codebase that trap has been found, so it lives in one function now.
 */
const plottable = (v) =>
  v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));

const cleanSeries = (data) =>
  (Array.isArray(data) ? data : [])
    .filter((d) => d && typeof d.label === 'string' && plottable(d.value))
    .map((d) => ({ label: d.label, value: Number(d.value) }));

function AguiTable({ spec, pageSize = 8 }) {
  const [page, setPage] = useState(0);
  const columns = Array.isArray(spec.columns) ? spec.columns : [];
  const rows = (Array.isArray(spec.rows) ? spec.rows : []).filter(Array.isArray);
  if (!columns.length || !rows.length) return null;

  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const cur = Math.min(page, pages - 1);
  const slice = rows.slice(cur * pageSize, cur * pageSize + pageSize);

  return (
    <div>
      <div className="cf-table-wrap">
        <table className="cf-table">
          <thead>
            <tr>{columns.map((c, i) => <th key={i}>{renderInline(normaliseText(c), `th${i}`)}</th>)}</tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={i}>
                {columns.map((_, j) => <td key={j}>{renderCell(r[j])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="cf-pager">
          <span className="cf-pager-info">
            {cur * pageSize + 1}–{Math.min(rows.length, (cur + 1) * pageSize)} of {rows.length}
          </span>
          <div className="cf-pager-controls">
            <button
              className="cf-page-btn"
              disabled={cur === 0}
              onClick={() => setPage(cur - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft size={15} />
            </button>
            <span className="cf-page-num">{cur + 1} / {pages}</span>
            <button
              className="cf-page-btn"
              disabled={cur >= pages - 1}
              onClick={() => setPage(cur + 1)}
              aria-label="Next page"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AguiCards({ spec }) {
  const navigate = useNavigate();
  const items = (Array.isArray(spec.items) ? spec.items : []).filter(
    (it) => it && (it.title || it.body)
  );
  if (!items.length) return null;
  // A card carrying an in-app route (`to`) becomes a navigation shortcut the
  // user can click to jump straight to that module/tab.
  const go = (to) => {
    if (typeof to !== 'string' || !to.startsWith('/')) return;
    navigate(to);
  };
  return (
    <div className="agui-cards">
      {items.map((it, i) => {
        const nav = typeof it.to === 'string' && it.to.startsWith('/');
        return (
          <div
            className={`agui-card ${nav ? 'agui-card-nav' : ''}`}
            key={i}
            role={nav ? 'button' : undefined}
            tabIndex={nav ? 0 : undefined}
            onClick={nav ? () => go(it.to) : undefined}
            onKeyDown={nav ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(it.to); } } : undefined}
          >
            <div className="agui-card-head">
              {it.title && <span className="agui-card-title">{renderInline(normaliseText(it.title), 'ct')}</span>}
              {it.badge && <span className="agui-card-badge">{normaliseText(it.badge)}</span>}
            </div>
            {it.subtitle && <div className="agui-card-sub">{renderInline(normaliseText(it.subtitle), 'cs')}</div>}
            {it.body && <div className="agui-card-body">{renderCell(it.body)}</div>}
            {nav && <span className="agui-card-open">Open <ArrowRight size={13} /></span>}
          </div>
        );
      })}
    </div>
  );
}

// Series of {name, points:[{label,value}]}, for the multi-series charts.
const cleanSeriesSet = (series) =>
  (Array.isArray(series) ? series : [])
    .map((s) => ({ name: String(s?.name ?? ''), points: cleanSeries(s?.points) }))
    .filter((s) => s.points.length);

// A stack is a label with named parts. Parts that are not numbers are dropped
// rather than treated as zero — a missing figure and a figure of nought are
// different claims about a case, and stacking them the same way states the
// wrong one.
const cleanStacks = (data) =>
  (Array.isArray(data) ? data : [])
    .map((d) => ({
      label: String(d?.label ?? ''),
      parts: (Array.isArray(d?.parts) ? d.parts : [])
        .filter((p) => p && plottable(p.value))
        .map((p) => ({ name: String(p.name ?? ''), value: Number(p.value) })),
    }))
    .filter((d) => d.label && d.parts.length);

const cleanPoints = (data) =>
  (Array.isArray(data) ? data : [])
    .filter((d) => d && plottable(d.x) && plottable(d.y))
    .map((d) => ({ x: Number(d.x), y: Number(d.y), label: d.label ? String(d.label) : undefined }));

// Every row must be as wide as the column list, or the grid draws a ragged
// last row that reads as missing data rather than as a malformed spec.
const cleanGrid = (spec) => {
  const rows = (Array.isArray(spec.rows) ? spec.rows : []).map(String);
  const cols = (Array.isArray(spec.cols) ? spec.cols : []).map(String);
  const raw = Array.isArray(spec.values) ? spec.values : [];
  if (!rows.length || !cols.length || raw.length !== rows.length) return null;
  const values = raw.map((r) =>
    (Array.isArray(r) ? r : []).slice(0, cols.length)
      // A heat cell is the one place a missing value MUST become something,
      // because the grid has to stay rectangular. Zero is the honest choice
      // for a count grid, and the row/column check above already rejects a
      // grid that is missing whole cells rather than values.
      .map((v) => (plottable(v) ? Number(v) : 0)));
  if (values.some((r) => r.length !== cols.length)) return null;
  return { rows, cols, values };
};

function AguiComponent({ spec }) {
  let body = null;
  if (spec.type === 'bar-chart') {
    const data = cleanSeries(spec.data);
    body = data.length ? <HBarList data={data} /> : null;
  } else if (spec.type === 'pie-chart') {
    const data = cleanSeries(spec.data);
    body = data.length ? <Donut data={data} /> : null;
  } else if (spec.type === 'line-chart') {
    const data = cleanSeries(spec.data);
    // Two points is a pair of numbers, not a trend, and drawing a line through
    // them invites a reading the data does not support.
    body = data.length >= 3 ? <TrendArea data={data} labelEvery={Math.ceil(data.length / 8)} /> : null;
  } else if (spec.type === 'multi-line-chart') {
    const series = cleanSeriesSet(spec.series);
    // Every series must share an x-axis; ragged series would draw lines that
    // silently mean different periods.
    const even = series.length > 0 && series.every((s) => s.points.length === series[0].points.length);
    body = even && series[0].points.length >= 2
      ? <MultiLine series={series} labelEvery={Math.ceil(series[0].points.length / 8)} />
      : null;
  } else if (spec.type === 'stacked-bar-chart') {
    const data = cleanStacks(spec.data);
    body = data.length ? <StackedBars data={data} /> : null;
  } else if (spec.type === 'heat-grid') {
    const grid = cleanGrid(spec);
    body = grid ? <HeatGrid {...grid} /> : null;
  } else if (spec.type === 'scatter-plot') {
    const data = cleanPoints(spec.data);
    body = data.length >= 2
      ? <Scatter data={data} xLabel={String(spec.xLabel || 'x')} yLabel={String(spec.yLabel || 'y')} />
      : null;
  } else if (spec.type === 'funnel') {
    const data = cleanSeries(spec.data);
    body = data.length >= 2 ? <Funnel data={data} /> : null;
  } else if (spec.type === 'pyramid') {
    const data = cleanSeries(spec.data);
    body = data.length >= 2 ? <Pyramid data={data} /> : null;
  } else if (spec.type === 'sankey') {
    const nodes = (Array.isArray(spec.nodes) ? spec.nodes : []).filter((n) => n && n.id != null);
    const links = (Array.isArray(spec.links) ? spec.links : [])
      .filter((l) => l && plottable(l.value) && Number(l.value) > 0);
    body = nodes.length >= 2 && links.length ? <Sankey nodes={nodes} links={links} /> : null;
  } else if (spec.type === 'table') {
    body = <AguiTable spec={spec} />;
  } else if (spec.type === 'cards') {
    body = <AguiCards spec={spec} />;
  } else if (spec.type === 'geo-map') {
    body = Array.isArray(spec.data) && spec.data.length ? <GeoHeatMap spec={spec} /> : null;
  } else if (spec.type === 'network-graph') {
    body = Array.isArray(spec.nodes) && spec.nodes.length ? <NetworkGraph spec={spec} /> : null;
  }
  if (!body) return null;
  return (
    <div className="agui-block">
      {spec.title && <div className="agui-block-title">{renderInline(normaliseText(spec.title), 'bt')}</div>}
      {body}
    </div>
  );
}

export default function AguiRenderer({ components }) {
  if (!Array.isArray(components) || components.length === 0) return null;
  return (
    <div className="agui-components">
      {components.map((c, i) => <AguiComponent spec={c} key={i} />)}
    </div>
  );
}
