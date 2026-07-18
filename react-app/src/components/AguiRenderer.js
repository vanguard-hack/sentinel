import React, { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { HBarList, Donut } from './Charts';
import GeoHeatMap from './GeoHeatMap';
import NetworkGraph from './NetworkGraph';

// AG-UI-style static generative UI renderer for the assistant.
// The RAG backend proposes typed component specs; this module validates and
// renders them with app-owned components — the agent never injects markup.
//
// Supported specs (see functions/rag/index.js AGUI_INSTRUCTION):
//   { type: 'bar-chart', title, data: [{ label, value }] }
//   { type: 'pie-chart', title, data: [{ label, value }] }
//   { type: 'table',     title, columns: [str], rows: [[cell, ...]] }
//   { type: 'cards',     title, items: [{ title, subtitle, body, badge }] }

const cleanSeries = (data) =>
  (Array.isArray(data) ? data : [])
    .filter((d) => d && typeof d.label === 'string' && Number.isFinite(Number(d.value)))
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
            <tr>{columns.map((c, i) => <th key={i}>{String(c)}</th>)}</tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={i}>
                {columns.map((_, j) => <td key={j}>{r[j] == null ? '—' : String(r[j])}</td>)}
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
  const items = (Array.isArray(spec.items) ? spec.items : []).filter(
    (it) => it && (it.title || it.body)
  );
  if (!items.length) return null;
  return (
    <div className="agui-cards">
      {items.map((it, i) => (
        <div className="agui-card" key={i}>
          <div className="agui-card-head">
            {it.title && <span className="agui-card-title">{it.title}</span>}
            {it.badge && <span className="agui-card-badge">{it.badge}</span>}
          </div>
          {it.subtitle && <div className="agui-card-sub">{it.subtitle}</div>}
          {it.body && <div className="agui-card-body">{it.body}</div>}
        </div>
      ))}
    </div>
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
      {spec.title && <div className="agui-block-title">{spec.title}</div>}
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
