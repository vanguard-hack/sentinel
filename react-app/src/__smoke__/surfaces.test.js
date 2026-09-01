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
// from the palette is a module most officers never discover. Four pages
// shipped without entries — Action Queue, Export Approvals, Assurance and
// Shared with me — which is why this asserts the property rather than the four.
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
  expect(find('self test').map((e) => e.to)).toContain('/assurance');
  expect(find('shared').map((e) => e.to)).toContain('/shared');
});
