// Client-side PDF export: snapshot the actual rendered report (charts, donut,
// socio-economic map, colours and all) with html2canvas and lay it into an A4
// PDF with jsPDF. No server round-trip — it downloads immediately and is a
// pixel-faithful copy of what the officer sees on screen.
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { parseBlocks } from './richFormat';
import { readPdfResponse, downloadBase64Pdf } from './exportGate';
import { mapLimit } from './concurrency';

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
        el.classList.contains('rp-card-full') ||
        el.classList.contains('rp-card-banner') ||
        el.classList.contains('rp-standalone');
      sec.items.push({ el, wide });
    }
  }
  if (!sections.length) throw new Error('nothing to export');

  // Capture every block ONCE, up front, so the layout pass below is pure
  // arithmetic and never blocks on html2canvas mid-page. Blocks are captured
  // through a small concurrency pool rather than one `await` at a time OR a
  // bare Promise.all: a Home report runs 30+ of these (8 KPI tiles, the
  // trend chart, 24 more cards), and each html2canvas call clones the
  // ENTIRE page DOM into its own iframe. A bare Promise.all launches all 30+
  // of those clones at once — that's not parallelism, it's a resource
  // spike: it stayed slow (CPU/memory contention negated the concurrency
  // win) and produced undersized, illegible captures for some charts
  // (an iframe starved of a settled layout before html2canvas read its
  // size). A pool of a few at a time keeps most of the speed win — captures
  // still overlap their font/image-ready waits — without the 30-way pileup.
  // ponytail: fixed pool size, not tuned to device/memory; raise it (or make
  // it adaptive) if profiling on a real report shows room to go faster.
  const CAPTURE_CONCURRENCY = 4;
  const captureOne = async (it) => {
    if (!it.el.offsetHeight || !it.el.offsetWidth) return null;
    try {
      const canvas = await html2canvas(it.el, {
        scale: 2,
        backgroundColor: bg,
        useCORS: true,
        logging: false,
        windowWidth: element.scrollWidth,
        // html2canvas doesn't apply font-variant-numeric when it rasterizes
        // text, but it DOES measure glyph positions from the real (tabular)
        // layout — the mismatch shows up as a stray gap next to every "1"
        // (the digit tabular-nums pads the most). Strip it in the clone only.
        onclone: (doc) => {
          const style = doc.createElement('style');
          style.textContent = '* { font-variant-numeric: normal !important; }';
          doc.head.appendChild(style);
        },
      });
      if (!canvas.width || !canvas.height) return null;
      return { canvas, wide: it.wide, aspect: canvas.height / canvas.width };
    } catch {
      return null; // one bad block must not sink the whole export
    }
  };

  const counts = sections.map((sec) => sec.items.length);
  const flatResults = await mapLimit(sections.flatMap((sec) => sec.items), CAPTURE_CONCURRENCY, captureOne);
  const captured = [];
  let cursor = 0;
  sections.forEach((sec, i) => {
    const items = flatResults.slice(cursor, cursor + counts[i]).filter(Boolean);
    cursor += counts[i];
    if (items.length) captured.push({ name: sec.name, items });
  });
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
      if (b.type === 'table') {
        const head = (b.columns || []).map((c) => `<th>${mdInline(String(c ?? ''))}</th>`).join('');
        const rows = (b.rows || [])
          .map((r) => `<tr>${r.map((c) => `<td>${mdInline(String(c ?? ''))}</td>`).join('')}</tr>`)
          .join('');
        return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
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
    table { width: 100%; border-collapse: collapse; margin: 0 0 9px; }
    th, td { text-align: left; padding: 5px 7px; border-bottom: 1px solid #e2e7ef; font-size: 10px; }
    th { background: #f5f7fb; color: #5a6473; font-size: 8.5px; text-transform: uppercase; }
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

// ── Assistant conversation → professional PDF (server-rendered) ────────────
// This used to screenshot the live thread DOM with exportReportPdf() — the
// html2canvas path built for dashboards, which only ever splits a capture on
// `.rp-grid`/`.rp-card` boundaries. A chat thread has neither, so the whole
// transcript became ONE oversized canvas: long conversations either hit the
// browser's canvas-size cap (silently truncated / blank) or got squeezed
// onto a single page and came out too small to read. A transcript is text
// plus the occasional table or chart spec, so it takes the same SmartBrowz
// route as the case-diary and investigation-summary exports: real text, real
// pagination, crisp at any length — and it renders straight from the
// session's own message data, so nothing on screen has to be scrolled into
// view first.

const roleLabel = (r) => (r === 'user' ? 'Officer' : 'Assistant');

const seriesRow = (d) => `<div class="stat"><span>${esc(d.label ?? '')}</span><b>${esc(d.value ?? '')}</b></div>`;
const nodeLabel = (nodes, id) => {
  const n = (Array.isArray(nodes) ? nodes : []).find((x) => x && x.id === id);
  return n ? (n.label || n.id) : id;
};

// Best-effort HTML for one AG-UI component spec (see AguiRenderer.js for the
// full vocabulary — 17 types, each with its own field shape). The structured
// types render as real markup; chart/graph types have no static-HTML chart
// renderer here, so each one's own data — read per its OWN shape, not a
// generic label/value guess — is laid out as a table or list instead. A
// generic "does it have .data or .items with .label/.value" guess used to
// stand in for all of these; it only matched bar/pie/line/funnel/pyramid,
// so every other chart type (multi-line, stacked-bar, heat-grid, scatter,
// sankey, network-graph) rendered as an empty note with no data at all —
// exactly what a chart-shaped answer must never do.
function aguiToHtml(spec) {
  if (!spec || !spec.type) return '';
  const title = spec.title ? `<div class="agui-title">${esc(spec.title)}</div>` : '';
  const note = (text) => `<div class="agui-note">${esc(text)}</div>`;

  if (spec.type === 'table' && Array.isArray(spec.columns) && Array.isArray(spec.rows)) {
    const head = spec.columns.map((c) => `<th>${esc(c)}</th>`).join('');
    const rows = spec.rows
      .map((r) => `<tr>${(r || []).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
      .join('');
    return `<div class="agui-block">${title}<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  if (spec.type === 'cards' && Array.isArray(spec.items)) {
    const cards = spec.items.map((it) => `
      <div class="agui-card">
        ${it.title ? `<b>${esc(it.title)}</b>` : ''}${it.badge ? ` <span class="tag">${esc(it.badge)}</span>` : ''}
        ${it.subtitle ? `<div class="muted">${esc(it.subtitle)}</div>` : ''}
        ${it.body ? `<p>${esc(it.body)}</p>` : ''}
      </div>`).join('');
    return `<div class="agui-block">${title}<div class="agui-grid">${cards}</div></div>`;
  }
  if (spec.type === 'checklist' && Array.isArray(spec.items)) {
    const rows = spec.items
      .map((it) => `<div class="entry"><b>${esc(it.label)}</b>${it.detail ? ` <span class="muted">${esc(it.detail)}</span>` : ''}</div>`)
      .join('');
    return `<div class="agui-block">${title}${rows}</div>`;
  }
  if (spec.type === 'stat-tiles' && Array.isArray(spec.items)) {
    return `<div class="agui-block">${title}<div class="agui-grid">${spec.items.map(seriesRow).join('')}</div></div>`;
  }
  if (spec.type === 'timeline' && Array.isArray(spec.events)) {
    const rows = spec.events.map((e) => `
      <div class="tl-row"><div class="tl-dot"></div><div><b>${esc(e.label)}</b> <span class="muted">${esc(e.date)}</span>${e.detail ? `<p>${esc(e.detail)}</p>` : ''}</div></div>`).join('');
    return `<div class="agui-block">${title}${rows}</div>`;
  }
  // Simple label/value series: bar, pie, line, funnel, pyramid — all
  // `data: [{ label, value }]`.
  if (['bar-chart', 'pie-chart', 'line-chart', 'funnel', 'pyramid'].includes(spec.type) && Array.isArray(spec.data)) {
    const rows = spec.data.slice(0, 60).map(seriesRow).join('');
    return `<div class="agui-block">${title}${note('Shown as a chart in the app — data reproduced here:')}<div class="agui-grid">${rows}</div></div>`;
  }
  // multi-line-chart: series: [{ name, points: [{ label, value }] }].
  if (spec.type === 'multi-line-chart' && Array.isArray(spec.series)) {
    const body = spec.series.map((s) => {
      const rows = (Array.isArray(s.points) ? s.points : []).map(seriesRow).join('');
      return `<div class="agui-series"><div class="agui-series-name">${esc(s.name || '')}</div><div class="agui-grid">${rows}</div></div>`;
    }).join('');
    return `<div class="agui-block">${title}${note('Shown as a chart in the app — data reproduced here:')}${body}</div>`;
  }
  // stacked-bar-chart: data: [{ label, parts: [{ name, value }] }].
  if (spec.type === 'stacked-bar-chart' && Array.isArray(spec.data)) {
    const rows = spec.data.map((d) => {
      const parts = (Array.isArray(d.parts) ? d.parts : []).map((p) => `${esc(p.name)}: ${esc(p.value)}`).join(', ');
      return `<tr><td>${esc(d.label ?? '')}</td><td>${parts}</td></tr>`;
    }).join('');
    return `<div class="agui-block">${title}<table><thead><tr><th>Label</th><th>Breakdown</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  // heat-grid: rows: [str], cols: [str], values: [[n]].
  if (spec.type === 'heat-grid' && Array.isArray(spec.rows) && Array.isArray(spec.cols) && Array.isArray(spec.values)) {
    const head = spec.cols.map((c) => `<th>${esc(c)}</th>`).join('');
    const rows = spec.rows.map((r, i) => {
      const vals = (spec.values[i] || []).map((v) => `<td>${esc(v)}</td>`).join('');
      return `<tr><th>${esc(r)}</th>${vals}</tr>`;
    }).join('');
    return `<div class="agui-block">${title}<table><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  // scatter-plot: data: [{ x, y, label }].
  if (spec.type === 'scatter-plot' && Array.isArray(spec.data)) {
    const rows = spec.data.map((d) => `<tr><td>${esc(d.label ?? '')}</td><td>${esc(d.x)}</td><td>${esc(d.y)}</td></tr>`).join('');
    return `<div class="agui-block">${title}<table><thead><tr><th>Label</th><th>${esc(spec.xLabel || 'X')}</th><th>${esc(spec.yLabel || 'Y')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  // sankey: nodes: [{ id, label }], links: [{ source, target, value }].
  if (spec.type === 'sankey' && Array.isArray(spec.links)) {
    const rows = spec.links
      .map((l) => `<tr><td>${esc(nodeLabel(spec.nodes, l.source))}</td><td>${esc(nodeLabel(spec.nodes, l.target))}</td><td>${esc(l.value)}</td></tr>`)
      .join('');
    return `<div class="agui-block">${title}<table><thead><tr><th>From</th><th>To</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  // network-graph: nodes: [{ id, label, group }], links: [{ source, target }].
  if (spec.type === 'network-graph' && Array.isArray(spec.links)) {
    const rows = spec.links
      .map((l) => `<tr><td>${esc(nodeLabel(spec.nodes, l.source))}</td><td>${esc(nodeLabel(spec.nodes, l.target))}</td></tr>`)
      .join('');
    return `<div class="agui-block">${title}<table><thead><tr><th>From</th><th>To</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  // geo-map: data: [{ district, value }].
  if (spec.type === 'geo-map' && Array.isArray(spec.data)) {
    const rows = spec.data.map((d) => `<div class="stat"><span>${esc(d.district ?? '')}</span><b>${esc(d.value ?? '')}</b></div>`).join('');
    return `<div class="agui-block">${title}${note('Shown as a map in the app — data reproduced here:')}<div class="agui-grid">${rows}</div></div>`;
  }
  return title ? `<div class="agui-block">${title}${note('No data to show.')}</div>` : '';
}

function buildConversationHtml(session) {
  const messages = session.messages || [];
  const first = messages[0]?.ts;
  const last = messages[messages.length - 1]?.ts;
  const range = first && last ? `${pdfDate(first)} – ${pdfDate(last)}` : '';

  const body = messages.map((m) => {
    const files = Array.isArray(m.files) && m.files.length
      ? `<div class="files">${m.files.map((f) => `<span class="tag">${esc(f.name)}</span>`).join(' ')}</div>`
      : '';
    const components = Array.isArray(m.components) ? m.components.map(aguiToHtml).join('') : '';
    const sources = Array.isArray(m.sources) && m.sources.length
      ? `<div class="sources"><span class="muted">Sources: </span>${m.sources.map((s) => `<span class="tag">[${esc(s.n)}] ${esc(s.display_name)}</span>`).join(' ')}</div>`
      : '';
    return `
      <div class="msg msg-${m.role === 'user' ? 'user' : 'assistant'}">
        <div class="msg-head"><b>${esc(roleLabel(m.role))}</b><span>${pdfDateTime(m.ts)}</span></div>
        ${files}
        <div class="msg-body">${mdToHtml(m.content || '')}</div>
        ${components}
        ${sources}
      </div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    @page { size: A4; margin: 18mm 15mm; }
    body { font-family: "Helvetica Neue", Arial, sans-serif; color: #1a2230; font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
    .doc-head { border-bottom: 2px solid #5e6ad2; padding-bottom: 10px; margin-bottom: 16px; }
    .brand { font-size: 10px; letter-spacing: .12em; color: #5e6ad2; font-weight: 700; text-transform: uppercase; }
    .doc-head h1 { font-size: 19px; margin: 6px 0 2px; }
    .doc-head .sub { color: #5a6473; font-size: 11px; }
    .doc-head .exp { color: #8a93a2; font-size: 9.5px; margin-top: 4px; }
    .msg { border: 1px solid #e2e7ef; border-radius: 8px; padding: 10px 13px; margin-bottom: 10px; page-break-inside: avoid; overflow: hidden; }
    .msg-user { background: #f5f7fb; }
    .msg-assistant { background: #ffffff; }
    .msg-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 5px; }
    .msg-head b { font-size: 10px; color: #5e6ad2; text-transform: uppercase; letter-spacing: .03em; }
    .msg-head span { color: #8a93a2; font-size: 9px; }
    .msg-body p { margin: 0 0 8px; }
    .msg-body ul, .msg-body ol { margin: 0 0 8px; padding-left: 18px; }
    .msg-body h3 { font-size: 11.5px; margin: 10px 0 5px; }
    .msg-body blockquote { margin: 0 0 8px; padding-left: 9px; border-left: 3px solid #d7dde8; color: #5a6473; }
    .msg-body code { background: #eef1f6; border-radius: 3px; padding: 1px 4px; }
    .msg-body table { width: 100%; border-collapse: collapse; margin: 0 0 8px; }
    .msg-body th, .msg-body td { text-align: left; padding: 5px 7px; border-bottom: 1px solid #e2e7ef; font-size: 9.5px; }
    .msg-body th { background: #eef1f6; color: #5a6473; font-size: 8.5px; text-transform: uppercase; }
    .cite { color: #5e6ad2; font-weight: 700; font-size: 8.5px; }
    .files { margin-bottom: 6px; }
    .tag { display: inline-block; background: #eef1f8; color: #5e6ad2; border-radius: 20px; padding: 2px 8px; font-size: 8.5px; font-weight: 600; margin: 0 4px 4px 0; }
    .sources { margin-top: 6px; }
    .muted { color: #8a93a2; }
    .agui-block { margin: 8px 0; }
    .agui-title { font-weight: 700; font-size: 10.5px; margin-bottom: 5px; }
    .agui-note { color: #8a93a2; font-style: italic; font-size: 9.5px; margin-bottom: 5px; }
    .agui-grid { display: flex; flex-wrap: wrap; gap: 6px; }
    .stat { border: 1px solid #e2e7ef; border-radius: 6px; padding: 5px 9px; min-width: 90px; }
    .stat span { display: block; font-size: 8.5px; color: #8a93a2; }
    .stat b { font-size: 10.5px; }
    .agui-card { border: 1px solid #e2e7ef; border-radius: 6px; padding: 7px 9px; min-width: 140px; flex: 1 1 140px; }
    .agui-series { margin-bottom: 8px; }
    .agui-series-name { font-weight: 600; font-size: 9.5px; color: #5a6473; margin-bottom: 4px; }
    .entry { border: 1px solid #e2e7ef; border-radius: 6px; padding: 6px 9px; margin-bottom: 6px; }
    .agui-block table { width: 100%; border-collapse: collapse; margin-top: 4px; }
    .agui-block th, .agui-block td { text-align: left; padding: 5px 7px; border-bottom: 1px solid #e2e7ef; font-size: 9.5px; }
    .agui-block th { background: #f5f7fb; color: #5a6473; font-size: 8.5px; text-transform: uppercase; }
    .tl-row { display: flex; gap: 8px; padding: 0 0 8px 4px; border-left: 2px solid #d7dde8; margin-left: 3px; }
    .tl-row .tl-dot { width: 7px; height: 7px; border-radius: 50%; background: #5e6ad2; margin-top: 3px; }
    .empty { color: #8a93a2; font-style: italic; }
    .foot { margin-top: 20px; border-top: 1px solid #d7dde8; padding-top: 8px; color: #8a93a2; font-size: 8.5px; }
  </style></head><body>
    <div class="doc-head">
      <div class="brand">Sentinel · Karnataka State Police</div>
      <h1>${esc(session.title || 'Conversation')}</h1>
      <div class="sub">Assistant conversation transcript${range ? ' · ' + esc(range) : ''} · ${messages.length} message${messages.length === 1 ? '' : 's'}</div>
      <div class="exp">Exported ${esc(new Date().toLocaleString('en-IN'))}</div>
    </div>
    ${body || '<p class="empty">No messages in this conversation.</p>'}
    <div class="foot">Sentinel Assistant · AI-drafted answers are advisory only — verify before acting.</div>
  </body></html>`;
}

export async function exportConversationPdf(session) {
  if (!session || !Array.isArray(session.messages) || !session.messages.length) {
    throw new Error('nothing to export');
  }
  const html = buildConversationHtml(session);
  const res = await fetch('/server/rag/report-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, kind: 'assistant-conversation', title: session.title || 'Conversation' }),
  });
  const data = await readPdfResponse(res);
  const slug = (session.title || 'conversation')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'conversation';
  downloadBase64Pdf(data.pdf, `sentinel-${slug}-${new Date().toISOString().slice(0, 10)}.pdf`);
}
