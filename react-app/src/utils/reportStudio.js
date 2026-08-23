// Report Studio data layer — CRUD against the rag function (Stratus-backed,
// one blob per report + index) and the print-HTML builder used for the
// server-rendered A4 PDF download (SmartBrowz via /server/rag/report-pdf).
import { reportTypeById } from '../data/reportTemplates';

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const listReports = () => post('/server/rag/reportdocs/list').then((d) => d.reports || []);
export const getReport = (id) => post('/server/rag/reportdocs/get', { id }).then((d) => d.report);
export const saveReport = (rec) => post('/server/rag/reportdocs/save', rec).then((d) => d.report);
export const deleteReport = (id) => post('/server/rag/reportdocs/delete', { id });
export const aiPolish = (payload) => post('/server/rag/reportdocs/ai', payload).then((d) => d.text);

export const newReportId = () =>
  'rpt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

// ── PDF export ────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const val = (v) => (v && String(v).trim() ? esc(v) : '&nbsp;');

function fieldHtml(f, values) {
  return `<div class="fld" style="grid-column: span ${f.span || 12}">
    <div class="lbl">${esc(f.label)}</div>
    <div class="v">${val(values[f.id])}</div>
  </div>`;
}

function blockHtml(b, bi, values) {
  if (b.kind === 'fields') {
    return `${b.legend ? `<div class="legend">${esc(b.legend)}</div>` : ''}
      <div class="grid">${b.fields.map((f) => fieldHtml(f, values)).join('')}</div>`;
  }
  if (b.kind === 'table') {
    const rows = Array.isArray(values[b.id]) ? values[b.id] : [];
    return `${b.label ? `<div class="legend">${esc(b.label)}</div>` : ''}
      <table class="tbl"><thead><tr>${b.columns
        .map((c) => `<th${c.width ? ` style="width:${c.width}%"` : ''}>${esc(c.label)}</th>`)
        .join('')}</tr></thead>
      <tbody>${rows
        .map((r) => `<tr>${b.columns.map((c, ci) => `<td>${val(r[ci])}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>
      ${b.footnote ? `<div class="foot">${esc(b.footnote)}</div>` : ''}`;
  }
  if (b.kind === 'narrative') {
    const minH = Math.max(24, (b.lines || 4) * 13);
    return `<div class="legend">${esc(b.label)}</div>
      <div class="nar" style="min-height:${minH}px">${val(values[b.id]).replace(/\n/g, '<br/>')}</div>`;
  }
  if (b.kind === 'note') return `<p class="note">${esc(b.text)}</p>`;
  if (b.kind === 'signatures') {
    return `<div class="sigs">${b.blocks
      .map((sb, j) => `<div class="sig">
        <div class="sig-space"></div>
        <div class="sig-label">${esc(sb.label)}</div>
        ${(sb.fields || [])
          .map((f) => `<div class="sig-field">${esc(f)}: <span>${val(values[`b${bi}:${j}:${f}`])}</span></div>`)
          .join('')}
      </div>`)
      .join('')}</div>`;
  }
  return '';
}

// Free-layout (blank page) elements — absolutely positioned inside a canvas
// whose px dimensions match the on-screen designer (682×1005 @96dpi ≈ the A4
// content box), so what the officer laid out is what prints.
function freeElHtml(el) {
  const base = `position:absolute;left:${Number(el.x) || 0}px;top:${Number(el.y) || 0}px;` +
    `width:${Number(el.w) || 100}px;font-size:${Number(el.fontSize) || 12}px;` +
    `color:${esc(el.color || '#111')};font-weight:${el.bold ? 700 : 400};text-align:${esc(el.align || 'left')};`;
  if (el.type === 'title') return `<div style="${base}">${val(el.text)}</div>`;
  if (el.type === 'field') {
    return `<div style="${base}">
      <div style="font-size:${Math.max(7, (Number(el.fontSize) || 12) - 4)}px;text-transform:uppercase;letter-spacing:.4px;color:#555;text-align:left;font-weight:400">${esc(el.label || '')}</div>
      <div style="border-bottom:1px dotted #666;min-height:${(Number(el.fontSize) || 12) + 5}px;padding:1px 2px">${val(el.text)}</div>
    </div>`;
  }
  if (el.type === 'text') {
    return `<div style="${base}min-height:${Number(el.h) || 24}px;white-space:pre-wrap;line-height:1.45">${val(el.text)}</div>`;
  }
  if (el.type === 'bullets') {
    const items = String(el.text || '').split('\n').filter((l) => l.trim());
    return `<ul style="${base}margin:0;padding-left:${(Number(el.fontSize) || 12) + 6}px;line-height:1.5">${items.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
  }
  if (el.type === 'table') {
    const rows = Array.isArray(el.rows) ? el.rows : [];
    return `<table style="${base}border-collapse:collapse" cellspacing="0">
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td style="border:1px solid #444;padding:3px 5px;font-size:inherit;vertical-align:top">${val(c)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
  }
  return '';
}

export function buildReportHtml(type, report) {
  const pagesHtml = (report.pages || [])
    .map((p, i, arr) => {
      const footer = `<footer class="pgno">${esc(report.title || type.name)} — Page ${i + 1} of ${arr.length}</footer>`;
      if (p.sheetId === 'blank') {
        return `<section class="sheet">
          <div style="position:relative;width:682px;height:1005px">
            ${(p.elements || []).map(freeElHtml).join('')}
          </div>
          ${footer}
        </section>`;
      }
      const sheet = type.sheets.find((s) => s.id === p.sheetId)
        || (type.extraSheets || []).find((s) => s.id === p.sheetId)
        || { title: 'Sheet', blocks: [] };
      return `<section class="sheet">
        <header class="hdr">
          <div class="org">KARNATAKA STATE POLICE</div>
          <h1>${esc(sheet.title)}</h1>
          ${sheet.subtitle ? `<div class="sub">${esc(sheet.subtitle)}</div>` : ''}
        </header>
        ${(sheet.blocks || []).map((b, bi) => blockHtml(b, bi, p.values || {})).join('')}
        ${footer}
      </section>`;
    })
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"/><style>
    @page { size: A4; margin: 14mm 13mm; }
    * { box-sizing: border-box; }
    body { font: 10.5px/1.45 'Times New Roman', Georgia, serif; color: #111; margin: 0; }
    .sheet { page-break-after: always; position: relative; min-height: 250mm; padding-bottom: 26px; }
    .sheet:last-child { page-break-after: auto; }
    .hdr { text-align: center; border-bottom: 1.5px solid #111; padding-bottom: 6px; margin-bottom: 10px; }
    .org { font-size: 9px; letter-spacing: 3px; }
    h1 { font-size: 13px; letter-spacing: 1px; margin: 3px 0 0; }
    .sub { font-size: 9px; font-style: italic; color: #333; }
    .legend { font-size: 10px; font-weight: bold; margin: 9px 0 3px; }
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 5px 10px; margin: 5px 0; }
    .lbl { font-size: 7.5px; text-transform: uppercase; letter-spacing: .4px; color: #444; }
    .v { border-bottom: 1px dotted #666; min-height: 14px; padding: 1px 2px; }
    .tbl { width: 100%; border-collapse: collapse; margin: 4px 0; }
    .tbl th, .tbl td { border: 1px solid #333; padding: 3px 4px; font-size: 9.5px; text-align: left; vertical-align: top; }
    .tbl th { background: #eee; font-size: 8.5px; }
    .foot { font-size: 8px; font-style: italic; color: #444; margin: 2px 0 6px; }
    .nar { border: 1px solid #999; padding: 5px 7px; margin: 2px 0 6px; white-space: pre-wrap; }
    .note { font-size: 9.5px; font-style: italic; margin: 8px 0; }
    .sigs { display: flex; flex-wrap: wrap; gap: 18px; justify-content: space-between; margin-top: 22px; }
    .sig { min-width: 180px; max-width: 46%; }
    .sig-space { height: 30px; border-bottom: 1px solid #333; margin-bottom: 3px; }
    .sig-label { font-size: 9px; font-weight: bold; }
    .sig-field { font-size: 9px; } .sig-field span { border-bottom: 1px dotted #666; padding: 0 4px; }
    .pgno { position: absolute; bottom: 0; right: 0; font-size: 8px; color: #555; }
  </style></head><body>${pagesHtml}</body></html>`;
}

export async function downloadReportPdf(report) {
  const type = reportTypeById(report.typeId);
  if (!type) throw new Error('Unknown report type');
  const html = buildReportHtml(type, report);
  const res = await fetch('/server/rag/report-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.pdf) throw new Error(data.error || `PDF export failed (HTTP ${res.status})`);
  const bin = atob(data.pdf);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(report.title || type.name).replace(/[^\w\d-]+/g, '-').slice(0, 80)}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
