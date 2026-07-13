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
