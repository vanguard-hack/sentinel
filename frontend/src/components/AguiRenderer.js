import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { HeatGrid, Scatter, Funnel, Pyramid, StackedBars, Sankey } from './Charts';
// Converted to the vendored Bklit set — see components/charts/.
import TrendArea from './charts/TrendArea';
import TrendLine from './charts/TrendLine';
import HBarList from './charts/BarRows';
import Donut from './charts/Ring';
import { renderCell, renderInline, normaliseText } from '../utils/richFormat';
import GeoHeatMap from './GeoHeatMap';
import NetworkGraph from './NetworkGraph';

// AG-UI-style static generative UI renderer for the assistant. The RAG
// backend proposes typed component specs; this module validates and renders
// them with app-owned dashboard components — the agent never injects markup.
// A model can only propose what's in this list, so widening it widens what
// the assistant can usefully answer.
//
// Supported specs (see functions/rag/index.js AGUI_INSTRUCTION):
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
//   { type: 'checklist',         title, items: [{ label, detail, tone, meta }] }
//   { type: 'stat-tiles',        title, items: [{ label, value, hint, tone }] }
//   { type: 'timeline',          title, events: [{ date, label, detail }] }

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
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(null); // { col: number, dir: 1 | -1 }

  const columns = Array.isArray(spec.columns) ? spec.columns : [];
  const allRows = (Array.isArray(spec.rows) ? spec.rows : []).filter(Array.isArray);
  if (!columns.length || !allRows.length) return null;

  const filtered = q.trim()
    ? allRows.filter((r) => r.some((cell) => String(cell ?? '').toLowerCase().includes(q.trim().toLowerCase())))
    : allRows;

  const rows = sort
    ? [...filtered].sort((a, b) => {
        const av = a[sort.col], bv = b[sort.col];
        const an = Number(av), bn = Number(bv);
        const cmp = Number.isFinite(an) && Number.isFinite(bn)
          ? an - bn
          : String(av ?? '').localeCompare(String(bv ?? ''));
        return cmp * sort.dir;
      })
    : filtered;

  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const cur = Math.min(page, pages - 1);
  const slice = rows.slice(cur * pageSize, cur * pageSize + pageSize);

  const cycleSort = (col) => {
    setPage(0);
    setSort((s) => {
      if (!s || s.col !== col) return { col, dir: 1 };
      if (s.dir === 1) return { col, dir: -1 };
      return null; // third click clears the sort
    });
  };

  return (
    <div>
      {allRows.length > pageSize && (
        <input
          type="search"
          className="agui-table-search"
          placeholder="Search table…"
          aria-label="Search table"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0); }}
        />
      )}
      <div className="cf-table-wrap">
        <table className="cf-table">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={i} aria-sort={sort?.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="agui-table-sort" onClick={() => cycleSort(i)}>
                    {renderInline(normaliseText(c), `th${i}`)}
                    {sort?.col === i && (sort.dir === 1 ? ' ↑' : ' ↓')}
                  </button>
                </th>
              ))}
            </tr>
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
            <button className="cf-page-btn" disabled={cur === 0} onClick={() => setPage(cur - 1)} aria-label="Previous page">
              <ChevronLeft size={15} />
            </button>
            <span className="cf-page-num">{cur + 1} / {pages}</span>
            <button className="cf-page-btn" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} aria-label="Next page">
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
        return <AguiCard key={i} it={it} nav={nav} go={go} />;
      })}
    </div>
  );
}

// A single context card. Its expanded/clamped state is local so multiple
// cards in one block each expand independently (mirrors the useState +
// reveal-button pattern SourceCitations already uses for "+N more").
function AguiCard({ it, nav, go }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`agui-card agui-card-context ${nav ? 'agui-card-nav' : ''}`}
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
      {it.body && (
        <div className={`agui-card-body ${expanded ? 'agui-card-body-expanded' : ''}`}>{renderCell(it.body)}</div>
      )}
      {it.body && !expanded && (
        <button
          type="button"
          className="agui-card-more"
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          Show more
        </button>
      )}
      {nav && <span className="agui-card-open">Open <ArrowRight size={13} /></span>}
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

// Shared with ActionQueue.js's own severity vocabulary (overdue/critical/
// high) so a checklist or stat-tile drawn here reads exactly like the page
// an officer already knows, rather than inventing a second color language.
// An unrecognised or absent tone is neutral, never a guess.
const TONES = new Set(['overdue', 'critical', 'high', 'ok']);
const cleanTone = (t) => (TONES.has(t) ? t : 'neutral');

const hasText = (v) => typeof v === 'string' && v.trim() !== '';
// Same trap as `plottable`, for a value that is text rather than a chart
// number: a missing stat and a stat of "0" are different claims.
const hasValue = (v) => v !== null && v !== undefined && typeof v !== 'boolean' && String(v).trim() !== '';

const cleanChecklistItems = (items) =>
  (Array.isArray(items) ? items : [])
    .filter((it) => it && hasText(it.label))
    .map((it) => ({
      label: it.label,
      detail: hasText(it.detail) ? it.detail : null,
      tone: cleanTone(it.tone),
      meta: hasText(it.meta) ? it.meta : null,
    }));

const cleanStatTiles = (items) =>
  (Array.isArray(items) ? items : [])
    .filter((it) => it && hasText(it.label) && hasValue(it.value))
    .map((it) => ({
      label: it.label,
      value: String(it.value),
      hint: hasText(it.hint) ? it.hint : null,
      tone: cleanTone(it.tone),
    }));

// A date is never fabricated: an event with no date still renders, it just
// carries no date line, rather than inventing one to keep a column full.
const cleanTimelineEvents = (events) =>
  (Array.isArray(events) ? events : [])
    .filter((e) => e && hasText(e.label))
    .map((e) => ({
      label: e.label,
      date: hasText(e.date) ? e.date : null,
      detail: hasText(e.detail) ? e.detail : null,
    }));

function AguiChecklist({ items }) {
  return (
    <ul className="agui-checklist">
      {items.map((it, i) => (
        <li className={`agui-checklist-item tone-${it.tone}`} key={i}>
          <span className="agui-checklist-dot" aria-hidden="true" />
          <div className="agui-checklist-body">
            <span className="agui-checklist-label">{renderInline(normaliseText(it.label), `cl${i}`)}</span>
            {it.detail && (
              <span className="agui-checklist-detail">{renderInline(normaliseText(it.detail), `cd${i}`)}</span>
            )}
          </div>
          {it.meta && <span className="agui-checklist-meta">{normaliseText(it.meta)}</span>}
        </li>
      ))}
    </ul>
  );
}

function AguiStatTiles({ items }) {
  const [page, setPage] = useState(0);
  const perPage = 4;
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const cur = Math.min(page, pages - 1);
  const slice = items.slice(cur * perPage, cur * perPage + perPage);

  return (
    <div>
      <div className="agui-stat-tiles">
        {slice.map((it, i) => (
          <div className={`agui-stat-tile tone-${it.tone}`} key={cur * perPage + i}>
            <span className="agui-stat-tile-value">{it.value}</span>
            <span className="agui-stat-tile-label">{normaliseText(it.label)}</span>
            {it.hint && <span className="agui-stat-tile-hint">{normaliseText(it.hint)}</span>}
          </div>
        ))}
      </div>
      {pages > 1 && (
        <div className="cf-pager">
          <span className="cf-pager-info">{cur + 1} / {pages}</span>
          <div className="cf-pager-controls">
            <button className="cf-page-btn" disabled={cur === 0} onClick={() => setPage(cur - 1)} aria-label="Previous">
              <ChevronLeft size={15} />
            </button>
            <button className="cf-page-btn" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} aria-label="Next">
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AguiTimeline({ events }) {
  return (
    <ol className="agui-timeline">
      {events.map((e, i) => (
        <li className="agui-timeline-event" key={i}>
          {e.date && <span className="agui-timeline-date">{normaliseText(e.date)}</span>}
          <span className="agui-timeline-dot" aria-hidden="true" />
          <div className="agui-timeline-body">
            <span className="agui-timeline-label">{renderInline(normaliseText(e.label), `tl${i}`)}</span>
            {e.detail && (
              <span className="agui-timeline-detail">{renderInline(normaliseText(e.detail), `td${i}`)}</span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

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
    body = data.length >= 3 ? <TrendArea data={data} height={230} /> : null;
  } else if (spec.type === 'multi-line-chart') {
    const series = cleanSeriesSet(spec.series);
    // Every series must share an x-axis; ragged series would draw lines that
    // silently mean different periods.
    const even = series.length > 0 && series.every((s) => s.points.length === series[0].points.length);
    body = even && series[0].points.length >= 2
      ? <TrendLine series={series} height={250} />
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
  } else if (spec.type === 'checklist') {
    const items = cleanChecklistItems(spec.items);
    body = items.length ? <AguiChecklist items={items} /> : null;
  } else if (spec.type === 'stat-tiles') {
    const items = cleanStatTiles(spec.items);
    body = items.length ? <AguiStatTiles items={items} /> : null;
  } else if (spec.type === 'timeline') {
    const events = cleanTimelineEvents(spec.events);
    body = events.length ? <AguiTimeline events={events} /> : null;
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
