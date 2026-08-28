import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('react-router-dom', () => ({
  useParams: () => ({ reportId: 'rpt-x' }),
  useSearchParams: () => [{ get: () => null }],
  useNavigate: () => () => {},
}), { virtual: true });

jest.mock('../utils/reportStudio', () => ({
  listReports: () => Promise.resolve([]),
  getReport: () => Promise.resolve({
    id: 'rpt-x', typeId: 'fir', title: 'T', status: 'draft', refNo: '',
    pages: [
      { uid: 'pg-1', sheetId: 'fir-main', values: {} },
      { uid: 'pg-2', sheetId: 'blank', doc: null, html: '<p>hello</p>' },
    ],
  }),
  saveReport: (r) => Promise.resolve(r),
  newReportId: () => 'rpt-x',
  downloadReportPdf: () => Promise.resolve(),
  aiPolish: () => Promise.resolve('polished'),
  deleteReport: () => Promise.resolve({}),
}), { virtual: true });
jest.mock('../utils/investigation', () => ({ listInvestigations: () => Promise.resolve([
  { caseMasterId: 'c1', crimeNo: 'CR/1/2026', station: 'PS', district: 'D', sections: 'S302' },
]) }), { virtual: true });
jest.mock('../utils/audit', () => ({ logAudit: () => {} }), { virtual: true });
jest.mock('../components/TopBar', () => ({ __esModule: true, default: () => null }), { virtual: true });

const ReportEditor = require('../pages/ReportEditor').default;
const { ConfirmProvider } = require('../components/ConfirmDialog');

const mount = () => render(<ConfirmProvider><ReportEditor /></ConfirmProvider>);

test('toolbar formatting buttons work on both sheet kinds', async () => {
  mount();
  await screen.findByText(/FIRST INFORMATION REPORT/i, {}, { timeout: 15000 });
  await waitFor(() => expect(screen.getAllByTitle(/Bold/).length).toBeGreaterThan(0), { timeout: 15000 });
  screen.getAllByTitle(/Bold/).forEach((b) => fireEvent.click(b));
  screen.getAllByTitle(/Bullet list/).forEach((b) => fireEvent.click(b));
  screen.getAllByTitle(/Align centre/).forEach((b) => fireEvent.click(b));
}, 40000);

test('text box insert and float controls run without throwing', async () => {
  mount();
  await waitFor(() => expect(screen.queryByTitle(/Insert text box/)).toBeTruthy(), { timeout: 15000 });
  fireEvent.click(screen.getByTitle(/Insert text box/));
  await waitFor(() => expect(screen.getByTitle(/Float this content|Return this content/)).toBeTruthy());
  fireEvent.click(screen.getByTitle(/Float this content|Return this content/));
}, 40000);

test('case-link picker opens and links a case', async () => {
  mount();
  await waitFor(() => expect(screen.queryByTitle('Link this report to a case')).toBeTruthy(), { timeout: 15000 });
  fireEvent.click(screen.getByTitle('Link this report to a case'));
  await screen.findByText('CR/1/2026');
  fireEvent.click(screen.getByText('CR/1/2026'));
}, 40000);
