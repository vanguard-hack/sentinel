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
