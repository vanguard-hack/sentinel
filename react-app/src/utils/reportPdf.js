// Client-side PDF export: snapshot the actual rendered report (charts, donut,
// socio-economic map, colours and all) with html2canvas and lay it into an A4
// PDF with jsPDF. No server round-trip — it downloads immediately and is a
// pixel-faithful copy of what the officer sees on screen.
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

export async function exportReportPdf(element, filename) {
  if (!element) throw new Error('nothing to export');

  const bg =
    getComputedStyle(document.body).backgroundColor ||
    (document.documentElement.getAttribute('data-theme') === 'dark' ? '#000000' : '#ffffff');

  const canvas = await html2canvas(element, {
    scale: 2,
    backgroundColor: bg,
    useCORS: true,
    logging: false,
    windowWidth: element.scrollWidth,
  });

  const pdf = new jsPDF('p', 'mm', 'a4');
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 6;
  const imgW = pageW - margin * 2;
  const imgH = (canvas.height * imgW) / canvas.width;
  const img = canvas.toDataURL('image/jpeg', 0.9);

  let heightLeft = imgH;
  let position = margin;
  pdf.addImage(img, 'JPEG', margin, position, imgW, imgH);
  heightLeft -= pageH - margin * 2;

  while (heightLeft > 0) {
    position = margin - (imgH - heightLeft);
    pdf.addPage();
    pdf.addImage(img, 'JPEG', margin, position, imgW, imgH);
    heightLeft -= pageH - margin * 2;
  }

  pdf.save(filename || `sentinel-report-${new Date().toISOString().slice(0, 10)}.pdf`);
}

// ── Investigation Diary → professional PDF (server-rendered) ────────────────
// Builds a clean, print-styled HTML document of the ENTIRE case record — every
// section laid out properly — and has SmartBrowz render it to a real multi-page
// A4 PDF (crisp text, not a screenshot) via the rag function's report-pdf
// endpoint. Returns nothing; triggers a download.
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pdfDate = (ts) => (ts ? new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const pdfDateTime = (ts) => (ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

function buildDiaryHtml(rec) {
  const idRows = [
    ['Investigation ID', rec.investigationId], ['Crime No.', rec.crimeNo], ['Case No.', rec.caseNo],
    ['Case type', rec.caseType], ['Sections invoked', rec.sections], ['Police station', rec.station],
    ['District', rec.district], ['Investigating Officer', `${rec.ioRank ? rec.ioRank + ' ' : ''}${rec.ioName || 'Unassigned'}`],
    ['Date of registration', rec.registeredDate], ['Case status', rec.status], ['Last diary entry', rec.lastDiaryDate || 'None'],
  ];
  const idGrid = idRows.map(([k, v]) => `<div class="cell"><span>${esc(k)}</span><b>${esc(v || '—')}</b></div>`).join('');

  const diary = [...(rec.diaryEntries || [])].sort((a, b) => a.ts - b.ts).map((e) => `
    <div class="entry">
      <div class="entry-head"><b>Case Diary Entry No. ${esc(e.serial)}</b><span>${pdfDate(e.ts)}</span></div>
      <p class="narr">${esc(e.narrative)}</p>
      <div class="meta">
        ${e.placesVisited ? `<span><i>Places visited:</i> ${esc(e.placesVisited)}</span>` : ''}
        ${e.personsExamined ? `<span><i>Persons examined:</i> ${esc(e.personsExamined)}</span>` : ''}
        ${(e.departureTime || e.returnTime) ? `<span><i>Departure/return:</i> ${esc(e.departureTime || '—')} – ${esc(e.returnTime || '—')}</span>` : ''}
        <span><i>Recorded by:</i> ${esc(e.ioName || 'IO')}</span>
      </div>
    </div>`).join('') || '<p class="empty">No diary entries on record.</p>';

  const statements = [...(rec.statements || [])].sort((a, b) => a.ts - b.ts).map((s) => `
    <div class="entry">
      <div class="entry-head"><b>${esc(s.personName)} <span class="tag">${esc(s.role || 'Witness')}</span></b><span>${pdfDate(s.ts)}</span></div>
      <p class="narr">${esc(s.text)}</p>
    </div>`).join('') || '<p class="empty">No statements recorded.</p>';

  const evidence = [...(rec.evidence || [])].sort((a, b) => a.ts - b.ts).map((e) => `
    <div class="entry">
      <div class="entry-head"><b>${esc(e.description)}</b><span>${pdfDate(e.ts)}</span></div>
      <div class="meta">
        ${e.type ? `<span><i>Type:</i> ${esc(e.type)}</span>` : ''}
        ${e.seizureMemoRef ? `<span><i>Seizure memo:</i> ${esc(e.seizureMemoRef)}</span>` : ''}
        ${e.location ? `<span><i>Stored at:</i> ${esc(e.location)}</span>` : ''}
        ${e.fslStatus ? `<span><i>FSL status:</i> ${esc(e.fslStatus)}</span>` : ''}
      </div>
    </div>`).join('') || '<p class="empty">No evidence logged.</p>';

  const persons = (rec.persons || []).map((p) => `
    <tr><td>${esc(p.name)}</td><td>${esc(p.role || '—')}</td><td>${esc(p.status || '—')}</td><td>${esc(p.notes || '')}</td></tr>`).join('')
    || '<tr><td colspan="4" class="empty">No persons recorded.</td></tr>';

  const timeline = [...(rec.timeline || [])].sort((a, b) => a.ts - b.ts).map((t) => `
    <div class="tl-row"><div class="tl-dot"></div><div><b>${esc(t.type || 'Event')}</b> <span class="muted">${pdfDateTime(t.ts)}</span><p>${esc(t.detail)}</p></div></div>`).join('')
    || '<p class="empty">No timeline events.</p>';

  const findings = [...(rec.findings || [])].sort((a, b) => a.ts - b.ts).map((f) => `
    <div class="entry"><div class="entry-head"><b>${esc(f.type || 'Observation')}</b><span>${pdfDate(f.ts)}</span></div><p class="narr">${esc(f.note)}</p></div>`).join('')
    || '<p class="empty">No findings recorded.</p>';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    @page { size: A4; margin: 18mm 15mm; }
    body { font-family: "Helvetica Neue", Arial, sans-serif; color: #1a2230; font-size: 11px; line-height: 1.5; }
    .doc-head { border-bottom: 2px solid #2545a6; padding-bottom: 10px; margin-bottom: 16px; }
    .brand { font-size: 10px; letter-spacing: .12em; color: #2545a6; font-weight: 700; text-transform: uppercase; }
    .doc-head h1 { font-size: 19px; margin: 6px 0 2px; }
    .doc-head .sub { color: #5a6473; font-size: 11px; }
    .doc-head .exp { color: #8a93a2; font-size: 9.5px; margin-top: 4px; }
    h2 { font-size: 12.5px; color: #2545a6; border-bottom: 1px solid #d7dde8; padding-bottom: 4px; margin: 20px 0 10px; page-break-after: avoid; }
    .idgrid { display: flex; flex-wrap: wrap; gap: 8px 0; }
    .idgrid .cell { width: 33.33%; padding-right: 10px; }
    .idgrid .cell span { display: block; font-size: 8.5px; text-transform: uppercase; letter-spacing: .04em; color: #8a93a2; }
    .idgrid .cell b { font-size: 11px; }
    .entry { border: 1px solid #e2e7ef; border-radius: 6px; padding: 9px 11px; margin-bottom: 8px; page-break-inside: avoid; }
    .entry-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
    .entry-head b { font-size: 11.5px; }
    .entry-head > span { color: #8a93a2; font-size: 9.5px; white-space: nowrap; padding-left: 10px; }
    .tag { background: #eef1f8; color: #2545a6; border-radius: 20px; padding: 1px 7px; font-size: 8.5px; font-weight: 600; }
    .narr { margin: 2px 0 5px; white-space: pre-wrap; }
    .meta { display: flex; flex-wrap: wrap; gap: 4px 14px; color: #5a6473; font-size: 9.5px; }
    .meta i { color: #8a93a2; font-style: normal; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e7ef; font-size: 10px; vertical-align: top; }
    th { background: #f5f7fb; color: #5a6473; font-size: 8.5px; text-transform: uppercase; letter-spacing: .04em; }
    .tl-row { display: flex; gap: 9px; padding: 0 0 10px 4px; border-left: 2px solid #d7dde8; margin-left: 3px; position: relative; }
    .tl-row:last-child { border-left-color: transparent; }
    .tl-dot { position: absolute; left: -5px; top: 3px; width: 8px; height: 8px; border-radius: 50%; background: #2545a6; }
    .tl-row p { margin: 2px 0 0; }
    .muted { color: #8a93a2; font-size: 9.5px; }
    .empty { color: #8a93a2; font-style: italic; }
    .foot { margin-top: 22px; border-top: 1px solid #d7dde8; padding-top: 8px; color: #8a93a2; font-size: 8.5px; }
  </style></head><body>
    <div class="doc-head">
      <div class="brand">Sentinel · Karnataka State Police</div>
      <h1>Case Diary — ${esc(rec.crimeNo || rec.caseMasterId)}</h1>
      <div class="sub">Case Diary Statement under Section 172 BNSS · ${esc(rec.caseType || 'Investigation')}${rec.sections ? ' · ' + esc(rec.sections) : ''}</div>
      <div class="exp">Generated ${esc(new Date().toLocaleString('en-IN'))} · Advisory working document</div>
    </div>
    <h2>Case Identifiers (IIF-1 / IIF-2)</h2>
    <div class="idgrid">${idGrid}</div>
    <h2>Case Diary Entries — Section 172 BNSS</h2>${diary}
    <h2>Witness Statements — Section 161 BNSS</h2>${statements}
    <h2>Evidence &amp; Seizures (IIF-5)</h2>${evidence}
    <h2>Persons Involved</h2>
    <table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Notes</th></tr></thead><tbody>${persons}</tbody></table>
    <h2>Timeline (IIF-3)</h2>${timeline}
    <h2>Investigator Findings</h2>${findings}
    <div class="foot">Sentinel Investigation Diary · Generated from the case record. Synthetic hackathon data — production use requires legal sign-off.</div>
  </body></html>`;
}

export async function exportInvestigationDiaryPdf(rec) {
  if (!rec) throw new Error('nothing to export');
  const html = buildDiaryHtml(rec);
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
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `case-diary-${(rec.crimeNo || rec.caseMasterId)}.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Export one conversation's transcript with a titled header. Temporarily
// injects a header into the thread element so the PDF is clearly labelled,
// then removes it.
export async function exportConversationPdf(threadEl, title) {
  if (!threadEl) throw new Error('nothing to export');
  const header = document.createElement('div');
  header.className = 'as-pdf-header';
  const safe = (title || 'Conversation').replace(/[<>&]/g, '');
  header.innerHTML =
    `<div class="as-pdf-brand">SENTINEL · Assistant Conversation</div>` +
    `<h1>${safe}</h1>` +
    `<div class="as-pdf-meta">Exported ${new Date().toLocaleString('en-IN')}</div>`;
  threadEl.prepend(header);
  const slug = (title || 'conversation')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'conversation';
  try {
    await exportReportPdf(threadEl, `sentinel-${slug}-${new Date().toISOString().slice(0, 10)}.pdf`);
  } finally {
    header.remove();
  }
}
