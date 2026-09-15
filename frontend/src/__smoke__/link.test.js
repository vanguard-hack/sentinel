/* The case link must reach the saved record — that is what makes the report
   show up under the case in the Investigation Diary. */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const saved = [];
jest.mock('react-router-dom', () => ({
  useParams: () => ({ reportId: 'rpt-x' }),
  useSearchParams: () => [{ get: () => null }],
  useNavigate: () => () => {},
}), { virtual: true });

jest.mock('../utils/reportStudio', () => ({
  listReports: () => Promise.resolve([]),
  getReport: () => Promise.resolve({
    id: 'rpt-x', typeId: 'fir', title: 'T', status: 'draft', refNo: '',
    pages: [{ uid: 'pg-1', sheetId: 'fir-main', values: {} }],
  }),
  saveReport: (r) => { global.__saved.push(r); return Promise.resolve(r); },
  newReportId: () => 'rpt-x',
  downloadReportPdf: () => Promise.resolve(),
  aiPolish: () => Promise.resolve('x'),
  deleteReport: () => Promise.resolve({}),
}), { virtual: true });

jest.mock('../utils/investigation', () => ({
  listInvestigations: () => Promise.resolve([]),
  // the full CaseMaster search — cases with no diary must be linkable too
  searchCases: () => Promise.resolve([
    { caseMasterId: '9001', crimeNo: '0042/2026', caseNo: 'CC/9/26', station: 'Ashok Nagar PS',
      district: 'Bengaluru City', caseType: 'Theft', registeredDate: '2026-03-02' },
  ]),
}), { virtual: true });
jest.mock('../utils/audit', () => ({ logAudit: () => {} }), { virtual: true });
jest.mock('../components/TopBar', () => ({ __esModule: true, default: () => null }), { virtual: true });

global.__saved = saved;

const ReportEditor = require('../pages/ReportEditor').default;
const { ConfirmProvider } = require('../components/ConfirmDialog');

test('linking a searched case persists caseMasterId and crimeNo', async () => {
  saved.length = 0;
  render(<ConfirmProvider><ReportEditor /></ConfirmProvider>);

  await waitFor(() => expect(screen.queryByTitle('Link this report to a case')).toBeTruthy(), { timeout: 15000 });
  fireEvent.click(screen.getByTitle('Link this report to a case'));

  const input = await screen.findByPlaceholderText(/Crime No/i);
  fireEvent.change(input, { target: { value: '0042' } });

  const hit = await screen.findByText('0042/2026', {}, { timeout: 5000 });
  fireEvent.click(hit);

  await waitFor(() => {
    const linked = saved.find((r) => r.caseMasterId === '9001');
    expect(linked).toBeTruthy();
    expect(linked.crimeNo).toBe('0042/2026');
  }, { timeout: 5000 });

  // ...and the toolbar reflects it, which is what was broken: the record saved
  // correctly but a re-running loader kept overwriting the local state.
  await screen.findByTitle('Open the linked case in Investigation Diary');
}, 40000);
