// Builds a self-contained HTML report from the Reports data and has the
// SmartBrowz service (via the rag function) render it to PDF.

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function kpiCell(label, value, sub = '') {
  return `<td class="kpi"><div class="kpi-v">${esc(value)}</div>
    <div class="kpi-l">${esc(label)}</div>
    ${sub ? `<div class="kpi-s">${esc(sub)}</div>` : ''}</td>`;
}

function barTable(title, rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<h2>${esc(title)}</h2>
  <table class="bars">${rows
    .map(
      (r) => `<tr><td class="bl">${esc(r.label)}</td>
      <td class="bt"><div class="bf" style="width:${((r.value / max) * 100).toFixed(1)}%"></div></td>
      <td class="bv">${r.value.toLocaleString()}</td></tr>`
    )
    .join('')}</table>`;
}

export function buildReportHtml(data) {
  const k = data.kpis;
  const now = new Date();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font: 11px/1.5 'Helvetica Neue', Arial, sans-serif; color: #1e293b; padding: 28px 34px; }
    header { display: flex; justify-content: space-between; align-items: baseline;
             border-bottom: 3px solid #1d4ed8; padding-bottom: 10px; margin-bottom: 18px; }
    h1 { font-size: 20px; color: #0f172a; }
    .sub { color: #64748b; font-size: 10px; }
    h2 { font-size: 13px; color: #1d4ed8; margin: 18px 0 8px; }
    table { width: 100%; border-collapse: collapse; }
    .kpis td { border: 1px solid #e2e8f0; padding: 10px 12px; width: 25%; }
    .kpi-v { font-size: 17px; font-weight: 700; color: #0f172a; }
    .kpi-l { font-size: 9.5px; color: #64748b; margin-top: 2px; }
    .kpi-s { font-size: 8.5px; color: #94a3b8; margin-top: 1px; }
    .bars td { padding: 3px 6px; }
    .bl { width: 30%; font-size: 10px; }
    .bt { width: 56%; } .bv { width: 14%; text-align: right; font-weight: 600; }
    .bf { height: 10px; background: #2a78d6; border-radius: 2px; min-width: 2px; }
    .recent th { text-align: left; font-size: 9px; color: #64748b; border-bottom: 1px solid #cbd5e1; padding: 4px 6px; }
    .recent td { font-size: 9.5px; padding: 4px 6px; border-bottom: 1px solid #f1f5f9; }
    footer { margin-top: 22px; padding-top: 8px; border-top: 1px solid #e2e8f0;
             color: #94a3b8; font-size: 8.5px; }
  </style></head><body>
  <header>
    <div><h1>SENTINEL — Crime Analytics Report</h1>
      <div class="sub">Karnataka State Police · Police FIR Data Store</div></div>
    <div class="sub">Generated ${esc(now.toLocaleString('en-IN'))}</div>
  </header>

  <h2>Key indicators</h2>
  <table class="kpis"><tr>
    ${kpiCell('FIRs registered', k.firs.toLocaleString(), `${k.thisYear.toLocaleString()} this year`)}
    ${kpiCell('Open investigations', k.open.toLocaleString(), `${k.openPct.toFixed(1)}% of all cases`)}
    ${kpiCell('Solved rate', `${k.solvedPct.toFixed(1)}%`, 'chargesheeted, on trial or decided')}
    ${kpiCell('Heinous share', `${k.heinousPct.toFixed(1)}%`, 'of registered cases')}
  </tr><tr>
    ${kpiCell('Accused on record', k.accused.toLocaleString())}
    ${kpiCell('Victims recorded', k.victims.toLocaleString())}
    ${kpiCell('Arrests & surrenders', k.arrests.toLocaleString())}
    ${kpiCell('Chargesheet rate', `${k.chargesheetPct.toFixed(1)}%`, `${k.chargesheets.toLocaleString()} chargesheets`)}
  </tr></table>

  ${barTable('Cases per year', data.yearly)}
  ${barTable('Case status', data.byStatus)}
  ${barTable('Crime by category', data.byCategory)}
  ${barTable('Top districts', data.byDistrict.slice(0, 12))}
  ${barTable('Top crime types', data.bySubHead)}

  <h2>Latest FIRs</h2>
  <table class="recent">
    <tr><th>Crime No</th><th>Date</th><th>Police station</th><th>District</th><th>Crime head</th><th>Status</th></tr>
    ${data.recent
      .map(
        (r) => `<tr><td>${esc(r.crimeNo)}</td><td>${esc(r.date)}</td><td>${esc(r.station)}</td>
        <td>${esc(r.district)}</td><td>${esc(r.head)}</td><td>${esc(r.status)}</td></tr>`
      )
      .join('')}
  </table>

  <footer>Live aggregates from the Catalyst Data Store at generation time ·
  Sentinel crime analytics platform · For official use only</footer>
  </body></html>`;
}

export async function downloadReportPdf(data) {
  const res = await fetch('/server/rag/report-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: buildReportHtml(data) }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.pdf) {
    throw new Error(out.error || `PDF service error (HTTP ${res.status})`);
  }
  const bytes = Uint8Array.from(atob(out.pdf), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `sentinel-report-${new Date().toISOString().slice(0, 10)}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
