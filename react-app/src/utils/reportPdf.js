// Client-side PDF export: snapshot the actual rendered report (charts, donut,
// socio-economic map, colours and all) with html2canvas and lay it into an A4
// PDF with jsPDF. No server round-trip — it downloads immediately and is a
// pixel-faithful copy of what the officer sees on screen.
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { parseBlocks } from './richFormat';
import { readPdfResponse, downloadBase64Pdf } from './exportGate';

// Export the report to PDF by capturing each card / section as its OWN image
// and flowing them onto A4 pages. A block is never split across a page break —
// if it doesn't fit the remaining space it moves to the next page (and a block
// taller than a whole page is scaled down to fit). This avoids both the
// mid-chart page cuts and the single-giant-canvas failure (browsers cap canvas
// size, so a very long report rendered in one shot silently fails).
export async function exportReportPdf(element, filename) {
  if (!element) throw new Error('nothing to export');
  const bg =
    getComputedStyle(document.body).backgroundColor ||
    (document.documentElement.getAttribute('data-theme') === 'dark' ? '#ffffff' : '#ffffff');

  // Ordered list of blocks to render: grids are broken into their individual
  // cards so every chart is captured whole; everything else (KPI row, standalone
  // chart, section headings) is captured as-is.
  const blocks = [];
  const isContainer = element.querySelector(':scope > .rp-grid, :scope > .rp-card, :scope > .rp-kpi-row, :scope > .rp-section-title');
  if (!isContainer) {
    // A single card/element (e.g. the AI-summary card) — capture it whole.
    blocks.push(element);
  } else {
    for (const child of Array.from(element.children)) {
      if (child.classList.contains('rp-grid')) {
        const cards = child.querySelectorAll(':scope > .rp-card');
        if (cards.length) cards.forEach((c) => blocks.push(c));
        else blocks.push(child);
      } else {
        blocks.push(child);
      }
    }
  }

  const pdf = new jsPDF('p', 'mm', 'a4');
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 8;
  const contentW = pageW - margin * 2;
  const gap = 4;
  let y = margin;
  let placed = false;

  for (const block of blocks) {
    if (!block || !block.offsetHeight || !block.offsetWidth) continue;

    let canvas;
    try {
      canvas = await html2canvas(block, {
        scale: 2,
        backgroundColor: bg,
        useCORS: true,
        logging: false,
        windowWidth: element.scrollWidth,
      });
    } catch {
      // A single problematic block must not abort the whole export.
      continue;
    }
    if (!canvas.width || !canvas.height) continue;

    let imgW = contentW;
    let imgH = (canvas.height * imgW) / canvas.width;
    // A block taller than a full page: scale it down so it fits on one page.
    if (imgH > pageH - margin * 2) {
      const s = (pageH - margin * 2) / imgH;
      imgH *= s;
      imgW *= s;
    }
    // Move to a new page when the block would overflow the current one.
    if (placed && y + imgH > pageH - margin) {
      pdf.addPage();
      y = margin;
    }
    const x = margin + (contentW - imgW) / 2; // centre scaled-down blocks
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', x, y, imgW, imgH);
    y += imgH + gap;
    placed = true;
  }

  if (!placed) throw new Error('nothing could be captured for the PDF');
  pdf.save(filename || `sentinel-report-${new Date().toISOString().slice(0, 10)}.pdf`);
}

// ── Home dashboard → sectioned, titled PDF ──────────────────────────────────
// exportReportPdf() above treats the report as one flat list of blocks and
// stretches every one of them to the full page width. That is right for a
// standalone chart and wrong here: it turned a page of small KPI tiles and
// donuts into one oversized image per page, with nothing on the page saying
// what any of it had to do with its neighbours.
//
// This walks the same rendered DOM but groups cards by the `data-pdf-section`
// attribute Reports.js's Card() stamps on every card (see that file's Band
// comments — the section names below ARE those bands). Each section gets its
// own page, a real vector header and title (not a screenshot, so it stays
// crisp at any zoom), and its cards packed several to a row instead of one
// per page — the column count follows each run's own aspect ratio, so eight
// short, wide KPI tiles pack 4-across and a pair of squarer donuts pack
// 2-across, matching what the row would actually hold on screen.
export async function exportHomeReportPdf(element, meta = {}) {
  if (!element) throw new Error('nothing to export');
  const bg =
    getComputedStyle(document.body).backgroundColor ||
    (document.documentElement.getAttribute('data-theme') === 'dark' ? '#ffffff' : '#ffffff');

  // Group the DOM into sections, preserving source order. Every section is
  // built of the SAME kind of thing everywhere except Overview, where the KPI
  // row is one element holding eight tiles rather than one card each — those
  // get unpacked into individual blocks so they pack like everything else.
  const sectionEls = Array.from(element.querySelectorAll('[data-pdf-section]'))
    .filter((el) => el.offsetHeight && el.offsetWidth);

  const sections = [];
  for (const el of sectionEls) {
    const name = el.getAttribute('data-pdf-section');
    let sec = sections[sections.length - 1];
    if (!sec || sec.name !== name) {
      sec = { name, items: [] };
      sections.push(sec);
    }
    if (el.classList.contains('rp-kpi-row')) {
      Array.from(el.children).forEach((tile) => sec.items.push({ el: tile, wide: false }));
    } else {
      // hero/wide cards get a full-width row to themselves; the standalone
      // crime-trend chart carries neither class but is exactly as full-width.
      const wide =
        el.classList.contains('rp-card-wide') ||
        el.classList.contains('rp-card-hero') ||
        el.classList.contains('rp-standalone');
      sec.items.push({ el, wide });
    }
  }
  if (!sections.length) throw new Error('nothing to export');

  // Capture every block ONCE, up front, so the layout pass below is pure
  // arithmetic and never blocks on html2canvas mid-page.
  const captured = [];
  for (const sec of sections) {
    const items = [];
    for (const it of sec.items) {
      if (!it.el.offsetHeight || !it.el.offsetWidth) continue;
      let canvas;
      try {
        canvas = await html2canvas(it.el, {
          scale: 2,
          backgroundColor: bg,
          useCORS: true,
          logging: false,
          windowWidth: element.scrollWidth,
        });
      } catch {
        continue; // one bad block must not sink the whole export
      }
      if (!canvas.width || !canvas.height) continue;
      items.push({ canvas, wide: it.wide, aspect: canvas.height / canvas.width });
    }
    if (items.length) captured.push({ name: sec.name, items });
  }
  if (!captured.length) throw new Error('nothing could be captured for the PDF');

  const pdf = new jsPDF('p', 'mm', 'a4');
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 12;
  const gap = 5;
  const contentW = pageW - margin * 2;
  const headerH = 20; // brand strip + rule + section title
  const footerH = 9;  // rule + source line, reserved on every page
  const bodyTop = margin + headerH;
  const bodyBottom = pageH - margin - footerH;

  const rangeLabel = meta.rangeLabel || '';
  const generated = new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const drawHeader = (sectionTitle, continued) => {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(94, 106, 210); // Linear lavender, this platform's one accent
    pdf.text('SENTINEL · KARNATAKA STATE POLICE', margin, margin + 3.5);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(140, 142, 150);
    pdf.text(
      `Home Report${rangeLabel ? ' · ' + rangeLabel : ''}`,
      pageW - margin, margin + 3.5, { align: 'right' }
    );
    pdf.setDrawColor(94, 106, 210);
    pdf.setLineWidth(0.5);
    pdf.line(margin, margin + 6, pageW - margin, margin + 6);

    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(13);
    pdf.setTextColor(26, 28, 35);
    pdf.text(sectionTitle + (continued ? ' (continued)' : ''), margin, margin + 15);
  };

  const drawFooter = (pageNum, pageCount) => {
    pdf.setDrawColor(224, 226, 234);
    pdf.setLineWidth(0.3);
    pdf.line(margin, pageH - margin - 5, pageW - margin, pageH - margin - 5);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);
    pdf.setTextColor(140, 142, 150);
    pdf.text(
      'Source: Sentinel · Synthetic Karnataka FIR dataset, Catalyst Data Store · Advisory only, verify before acting',
      margin, pageH - margin
    );
    pdf.text(
      `Generated ${generated}  ·  Page ${pageNum} of ${pageCount}`,
      pageW - margin, pageH - margin, { align: 'right' }
    );
  };

  // A run of consecutive non-wide items packs into a grid whose column count
  // follows the run's own shape: short, wide tiles (KPI cards) read best
  // 4-across; the squarer bento cards (donuts, tall lists) read best 2-across.
  // Decided once from the first item — every run in this report is uniform,
  // since a section only mixes shapes at a `wide` boundary, which always ends
  // the run.
  const columnsFor = (aspect) => (aspect < 0.5 ? 4 : 2);

  // One section per call, so `y` is this section's own local state rather
  // than a loop-scoped variable captured by helpers defined on every pass.
  const renderSection = (sec, isFirst) => {
    if (!isFirst) pdf.addPage();
    let y = bodyTop;
    drawHeader(sec.name, false);

    const ensureRoom = (rowH) => {
      if (y + rowH > bodyBottom) {
        pdf.addPage();
        drawHeader(sec.name, true);
        y = bodyTop;
      }
    };

    const placeFull = (item) => {
      let w = contentW;
      let h = item.aspect * w;
      const maxH = bodyBottom - bodyTop;
      if (h > maxH) { const s = maxH / h; h *= s; w *= s; }
      ensureRoom(h);
      const x = margin + (contentW - w) / 2;
      pdf.addImage(item.canvas.toDataURL('image/jpeg', 0.92), 'JPEG', x, y, w, h);
      y += h + gap;
    };

    const placeRun = (run) => {
      if (!run.length) return;
      const cols = columnsFor(run[0].aspect);
      for (let i = 0; i < run.length; i += cols) {
        const row = run.slice(i, i + cols);
        const w = (contentW - gap * (row.length - 1)) / cols;
        const heights = row.map((it) => it.aspect * w);
        const rowH = Math.max(...heights);
        ensureRoom(rowH);
        for (let ci = 0; ci < row.length; ci += 1) {
          const h = heights[ci];
          const x = margin + ci * (w + gap);
          // Short of the row's own tallest item: centred vertically, not
          // stretched — a stretched donut is a wrong donut.
          pdf.addImage(row[ci].canvas.toDataURL('image/jpeg', 0.92), 'JPEG', x, y + (rowH - h) / 2, w, h);
        }
        y += rowH + gap;
      }
    };

    let run = [];
    for (const item of sec.items) {
      if (item.wide) {
        placeRun(run); run = [];
        placeFull(item);
      } else {
        run.push(item);
      }
    }
    placeRun(run);
  };

  captured.forEach((sec, i) => renderSection(sec, i === 0));

  const pageCount = pdf.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i += 1) {
    pdf.setPage(i);
    drawFooter(i, pageCount);
  }

  pdf.save(meta.filename || `sentinel-home-report-${new Date().toISOString().slice(0, 10)}.pdf`);
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
    .doc-head { border-bottom: 2px solid #5e6ad2; padding-bottom: 10px; margin-bottom: 16px; }
    .brand { font-size: 10px; letter-spacing: .12em; color: #5e6ad2; font-weight: 700; text-transform: uppercase; }
    .doc-head h1 { font-size: 19px; margin: 6px 0 2px; }
    .doc-head .sub { color: #5a6473; font-size: 11px; }
    .doc-head .exp { color: #8a93a2; font-size: 9.5px; margin-top: 4px; }
    h2 { font-size: 12.5px; color: #5e6ad2; border-bottom: 1px solid #d7dde8; padding-bottom: 4px; margin: 20px 0 10px; page-break-after: avoid; }
    .idgrid { display: flex; flex-wrap: wrap; gap: 8px 0; }
    .idgrid .cell { width: 33.33%; padding-right: 10px; }
    .idgrid .cell span { display: block; font-size: 8.5px; text-transform: uppercase; letter-spacing: .04em; color: #8a93a2; }
    .idgrid .cell b { font-size: 11px; }
    .entry { border: 1px solid #e2e7ef; border-radius: 6px; padding: 9px 11px; margin-bottom: 8px; page-break-inside: avoid; }
    .entry-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
    .entry-head b { font-size: 11.5px; }
    .entry-head > span { color: #8a93a2; font-size: 9.5px; white-space: nowrap; padding-left: 10px; }
    .tag { background: #eef1f8; color: #5e6ad2; border-radius: 20px; padding: 1px 7px; font-size: 8.5px; font-weight: 600; }
    .narr { margin: 2px 0 5px; white-space: pre-wrap; }
    .meta { display: flex; flex-wrap: wrap; gap: 4px 14px; color: #5a6473; font-size: 9.5px; }
    .meta i { color: #8a93a2; font-style: normal; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e7ef; font-size: 10px; vertical-align: top; }
    th { background: #f5f7fb; color: #5a6473; font-size: 8.5px; text-transform: uppercase; letter-spacing: .04em; }
    .tl-row { display: flex; gap: 9px; padding: 0 0 10px 4px; border-left: 2px solid #d7dde8; margin-left: 3px; position: relative; }
    .tl-row:last-child { border-left-color: transparent; }
    .tl-dot { position: absolute; left: -5px; top: 3px; width: 8px; height: 8px; border-radius: 50%; background: #5e6ad2; }
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
    body: JSON.stringify({
      html,
      kind: 'case-diary',
      title: `Case Diary — ${rec.crimeNo || rec.caseMasterId}`,
    }),
  });
  const data = await readPdfResponse(res);
  downloadBase64Pdf(data.pdf, `case-diary-${(rec.crimeNo || rec.caseMasterId)}.pdf`);
}

// ── AI case summary → PDF (server-rendered) ────────────────────────────────
// This used to go through exportReportPdf(), the html2canvas path built for
// dashboards. That was wrong for a text brief in two ways: it produced a
// raster screenshot with unselectable, soft text, and — because that exporter
// never splits a single block across pages — any brief longer than one A4 page
// was SHRUNK to fit, which is what made the export come out unreadably small.
// A summary is prose, so it takes the same SmartBrowz route as the full diary:
// real text, real pagination, crisp at any length.

// Inline markdown → HTML. Escaped FIRST, so nothing the model wrote can inject
// markup into the document we hand the renderer.
const mdInline = (t) =>
  esc(t)
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[(\d+)\]/g, '<sup class="cite">[$1]</sup>');

// Block-level markdown → HTML, reusing the parser the on-screen renderer uses
// so the PDF and the screen can never drift apart.
function mdToHtml(text) {
  return parseBlocks(text)
    .map((b) => {
      if (b.type === 'h') return `<h3>${mdInline(b.text)}</h3>`;
      if (b.type === 'quote') return `<blockquote>${mdInline(b.text)}</blockquote>`;
      if (b.type === 'hr') return '<hr/>';
      if (b.type === 'list') {
        const tag = b.ordered ? 'ol' : 'ul';
        return `<${tag}>${b.items.map((i) => `<li>${mdInline(i)}</li>`).join('')}</${tag}>`;
      }
      return `<p class="narr">${b.lines.map(mdInline).join('<br/>')}</p>`;
    })
    .join('');
}

export async function exportInvestigationSummaryPdf(summary, citations, meta = {}) {
  if (!summary || !String(summary).trim()) throw new Error('nothing to export');
  const cites = (citations || [])
    .map((c) => `<li><b>[${esc(c.n)}]</b> ${esc(c.label)} <span class="muted">${pdfDate(c.date)}</span></li>`)
    .join('') || '<li class="empty">No source entries cited.</li>';

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    @page { size: A4; margin: 18mm 15mm; }
    body { font-family: "Helvetica Neue", Arial, sans-serif; color: #1a2230; font-size: 11px; line-height: 1.6; }
    .doc-head { border-bottom: 2px solid #5e6ad2; padding-bottom: 10px; margin-bottom: 16px; }
    .brand { font-size: 10px; letter-spacing: .12em; color: #5e6ad2; font-weight: 700; text-transform: uppercase; }
    .doc-head h1 { font-size: 19px; margin: 6px 0 2px; }
    .doc-head .sub { color: #5a6473; font-size: 11px; }
    .doc-head .exp { color: #8a93a2; font-size: 9.5px; margin-top: 4px; }
    .flag { background: #fff7e6; border: 1px solid #f0d9a8; color: #7a5c17; border-radius: 6px;
            padding: 8px 11px; font-size: 10px; margin-bottom: 16px; }
    h2 { font-size: 12.5px; color: #5e6ad2; border-bottom: 1px solid #d7dde8; padding-bottom: 4px;
         margin: 20px 0 10px; page-break-after: avoid; }
    h3 { font-size: 11.5px; margin: 14px 0 5px; page-break-after: avoid; }
    .narr { margin: 0 0 9px; }
    ul, ol { margin: 0 0 9px; padding-left: 20px; }
    li { margin-bottom: 4px; }
    blockquote { margin: 0 0 9px; padding-left: 10px; border-left: 3px solid #d7dde8; color: #5a6473; }
    code { background: #f5f7fb; border-radius: 3px; padding: 1px 4px; font-size: 10px; }
    hr { border: 0; border-top: 1px solid #e2e7ef; margin: 12px 0; }
    .cite { color: #5e6ad2; font-weight: 700; font-size: 8.5px; }
    .sources { list-style: none; padding: 0; font-size: 10px; }
    .sources li { padding: 4px 0; border-bottom: 1px solid #eef1f6; }
    .muted { color: #8a93a2; }
    .empty { color: #8a93a2; font-style: italic; }
    .foot { margin-top: 22px; border-top: 1px solid #d7dde8; padding-top: 8px; color: #8a93a2; font-size: 8.5px; }
  </style></head><body>
    <div class="doc-head">
      <div class="brand">Sentinel · Karnataka State Police</div>
      <h1>Investigation Summary — ${esc(meta.crimeNo || meta.caseMasterId || 'Case')}</h1>
      <div class="sub">State-of-the-investigation brief, drafted from the case record</div>
      <div class="exp">Generated ${esc(new Date().toLocaleString('en-IN'))}</div>
    </div>
    <div class="flag"><b>AI-drafted — advisory only.</b> Every statement below is drawn from this
      case's own diary entries, statements, timeline and findings. Verify each cited entry before
      relying on it.</div>
    <h2>Summary</h2>
    ${mdToHtml(summary)}
    <h2>Source Entries</h2>
    <ol class="sources">${cites}</ol>
    <div class="foot">Sentinel Investigation Diary · Generated from the case record. Synthetic hackathon data — production use requires legal sign-off.</div>
  </body></html>`;

  const res = await fetch('/server/rag/report-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html,
      kind: 'investigation-summary',
      title: `Investigation Summary — ${meta.crimeNo || meta.caseMasterId || 'Case'}`,
    }),
  });
  const data = await readPdfResponse(res);
  downloadBase64Pdf(data.pdf, `investigation-summary-${(meta.crimeNo || meta.caseMasterId || 'case')}.pdf`);
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
    await exportReportPdf(
      threadEl,
      `sentinel-${slug}-${new Date().toISOString().slice(0, 10)}.pdf`,
    );
  } finally {
    header.remove();
  }
}
