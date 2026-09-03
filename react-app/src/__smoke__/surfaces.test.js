import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('react-router-dom', () => ({
  useParams: () => ({ reportId: 'rpt-x', caseMasterId: 'case-1' }),
  useSearchParams: () => [{ get: () => null }],
  useNavigate: () => () => {},
}), { virtual: true });

jest.mock('../utils/reportStudio', () => ({
  listReports: () => Promise.resolve([
    { id: 'r1', typeId: 'fir', title: 'FIR one', status: 'draft', pageCount: 2,
      updatedAt: Date.now(), createdByName: 'IO', caseMasterId: 'case-1', crimeNo: 'CR/1/2026' },
    { id: 'r2', typeId: 'nonexistent-type', title: 'Odd', status: 'final', pageCount: 1, updatedAt: Date.now() },
  ]),
  getReport: () => Promise.resolve({ id: 'r1', typeId: 'fir', title: 'T', status: 'draft', pages: [] }),
  saveReport: (r) => Promise.resolve(r),
  deleteReport: () => Promise.resolve({}),
  newReportId: () => 'rpt-x',
  downloadReportPdf: () => Promise.resolve(),
  aiPolish: () => Promise.resolve('x'),
}), { virtual: true });
jest.mock('../utils/audit', () => ({ logAudit: () => {} }), { virtual: true });
jest.mock('../components/TopBar', () => ({ __esModule: true, default: () => null }), { virtual: true });

const ReportStudio = require('../pages/ReportStudio').default;
const { ConfirmProvider } = require('../components/ConfirmDialog');

test('Report Studio hub renders, including a report whose type is unknown', async () => {
  render(<ConfirmProvider><ReportStudio /></ConfirmProvider>);
  await screen.findByText('FIR one');
  await screen.findByText('Odd');
  expect(screen.getByText(/CR\/1\/2026/)).toBeTruthy();
});

test('delete asks for confirmation via the custom dialog', async () => {
  render(<ConfirmProvider><ReportStudio /></ConfirmProvider>);
  await screen.findByText('FIR one');
  fireEvent.click(screen.getAllByTitle('Delete')[0]);
  await waitFor(() => expect(screen.getByText(/Delete report/i)).toBeTruthy());
});

// ── Every page is findable ────────────────────────────────────────────────
//
// ⌘K is how anyone who uses this daily moves around it, so a module missing
// from the palette is a module most officers never discover. Several pages
// shipped without entries — Action Queue, Export Approvals and Shared with me
// — which is why this asserts the property rather than naming them.
import { SEARCH_INDEX } from '../utils/searchIndex';
import { FEATURES } from '../utils/access';

test('every access-controlled page has a search entry', () => {
  // Pages reachable from a route with a feature key must be findable. Detail
  // routes (a single case, a single report) are excluded — they are reached
  // through their list, not by name.
  const indexed = new Set(SEARCH_INDEX.map((e) => e.to));
  const missing = FEATURES
    .filter((f) => f.path && !f.path.includes(':'))
    .filter((f) => !indexed.has(f.path))
    .map((f) => f.path);
  expect(missing).toEqual([]);
});

test('every search entry names a feature the access layer knows', () => {
  const known = new Set(FEATURES.map((f) => f.key));
  const unknown = SEARCH_INDEX.filter((e) => !known.has(e.feature)).map((e) => e.id);
  expect(unknown).toEqual([]);
});

test('the newly added pages are searchable by what an officer would type', () => {
  const find = (q) => SEARCH_INDEX.filter((e) => `${e.title} ${e.keywords}`.toLowerCase().includes(q));
  expect(find('sunset').map((e) => e.to)).toContain('/action-queue');
  expect(find('approve').map((e) => e.to)).toContain('/export-approvals');
  expect(find('shared').map((e) => e.to)).toContain('/shared');
});

import fs from 'fs';
import path from 'path';

// ── The top bar stays attached to the top ─────────────────────────────────
//
// A regression I shipped: `.page` was given side and top padding so the tables
// on those pages would stop running into the viewport edges. But every page
// using that class renders <TopBar/> as its FIRST CHILD, so page padding is bar
// padding — the bar lifted away from the top and both edges and read as a
// detached floating panel rather than as chrome.
//
// The fix is the split the rest of the app already uses (.cf-page / .cf-body):
// the shell has no padding, the body beneath the bar has all of it. These
// assert that split rather than the specific pages, because the next page
// added with this class will make the same mistake.

test('the page shell carries no padding of its own', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');
  const shell = css.slice(css.indexOf('\n.page {'), css.indexOf('\n.page-body {'));
  expect(shell).not.toMatch(/^\s*padding:/m);
});

test('the padding lives on the body beneath the bar', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');
  const body = css.slice(css.indexOf('\n.page-body {'));
  expect(body.slice(0, 240)).toMatch(/padding:/);
});

test('every page using the shell puts its content in a page-body', () => {
  const dir = path.join(__dirname, '..', 'pages');
  const offenders = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!src.includes('className="page"')) continue;
    if (!src.includes('className="page-body"')) offenders.push(`${file}: no page-body`);
    // TopBar must sit OUTSIDE the padded body, or it is inset again.
    const bar = src.indexOf('<TopBar');
    const body = src.indexOf('className="page-body"');
    if (bar === -1 || body === -1 || bar > body) offenders.push(`${file}: TopBar is not above page-body`);
  }
  expect(offenders).toEqual([]);
});

// ── Case status colours ───────────────────────────────────────────────────
//
// Two defects behind one complaint. The dropdown reused the CHIP classes on a
// 9px dot, and those set a 16% tint as the background — so every status read as
// the same pale smudge. And Cold and Closed both mapped to grey, which made the
// two states an officer most needs to tell apart identical: one says the file
// is finished, the other says it has stalled.
import { statusColor, STATUS_OPTIONS } from '../utils/investigation';

test('every case status has its own colour', () => {
  const used = STATUS_OPTIONS.map(statusColor);
  expect(new Set(used).size).toBe(STATUS_OPTIONS.length);
});

test('Cold and Closed are not the same colour', () => {
  // Opposite facts about a file. Sharing grey made the colour coding a lie.
  expect(statusColor('Cold')).not.toBe(statusColor('Closed'));
});

test('Cold is coloured as the problem the rest of the app says it is', () => {
  // coldCaseFlag raises it and the Action Queue carries it as an obligation.
  expect(statusColor('Cold')).toBe('red');
});

test('an unknown status still resolves rather than rendering colourless', () => {
  expect(statusColor('Nonsense')).toBe('grey');
  expect(statusColor(undefined)).toBe('grey');
});

test('the dot takes a solid colour, not the chip tint', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');
  const dot = css.slice(css.indexOf('span.inv-status-dot {'));
  expect(dot.slice(0, 200)).toMatch(/background:\s*currentColor/);
});

test('every status colour clears 4.5:1 against white', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');
  const lum = (h) => {
    const p = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  };
  const weak = [];
  for (const m of css.matchAll(/\.inv-status-(\w+) \{[^}]*color: (#[0-9a-f]{6})/g)) {
    const ratio = 1.05 / (lum(m[2]) + 0.05);
    if (ratio < 4.5) weak.push(`${m[1]} ${m[2]} ${ratio.toFixed(2)}:1`);
  }
  expect(weak).toEqual([]);
});

// ── Analytics paging must not truncate silently ───────────────────────────
//
// Three modules each grew their own copy of the paging loop with a different
// ceiling — 6,000 rows in aianalytics, 10,000 in fetchAllRows, 30,000 in
// crimelinks. At 2,200 cases none ever bit. At 30,000 all three do, and they
// did it silently: charts drawn from a fifth of the data, captioned as the
// whole of it. A truncated read is not a smaller answer, it is a different one.

test('no analytics module keeps its own paging loop', () => {
  const dir = path.join(__dirname, '..', 'utils');
  const offenders = [];
  for (const f of ['aianalytics.js', 'crimelinks.js', 'caselinkage.js', 'financial.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/for \(let (page|off|offset) = 0;/.test(src)) offenders.push(f);
  }
  expect(offenders).toEqual([]);
});

test('they all page through the shared helper instead', () => {
  const dir = path.join(__dirname, '..', 'utils');
  for (const f of ['aianalytics.js', 'crimelinks.js', 'caselinkage.js', 'financial.js']) {
    expect(fs.readFileSync(path.join(dir, f), 'utf8')).toMatch(/pageQuery/);
  }
});

test('the shared helper reports whether it stopped short', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'datastore.js'), 'utf8');
  const fn = src.slice(src.indexOf('export async function pageQuery'));
  expect(fn.slice(0, 900)).toMatch(/truncated/);
  expect(fn.slice(0, 900)).toMatch(/Object\.assign\(rows, \{ truncated/);
});

test('its ceiling clears the current dataset', () => {
  // 30,000 cases and 44,000 accused: a ceiling below either would truncate on
  // an ordinary load rather than only on an extreme one.
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'datastore.js'), 'utf8');
  const cap = Number(/cap = (\d+)/.exec(src.slice(src.indexOf('export async function pageQuery')))[1]);
  expect(cap).toBeGreaterThanOrEqual(50000);
});
