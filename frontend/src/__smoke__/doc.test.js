import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('react-router-dom', () => ({
  useParams: () => ({ reportId: 'rpt-x' }),
  useSearchParams: () => [{ get: () => null }],
  useNavigate: () => () => {},
}), { virtual: true });

const DOC = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'flow text' }] },
    {
      type: 'textBox',
      attrs: { x: 40, y: 50, width: 200, height: 90, bordered: true },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'boxed text' }] }],
    },
  ],
};

jest.mock('../utils/reportStudio', () => ({
  listReports: () => Promise.resolve([]),
  getReport: () => Promise.resolve({
    id: 'rpt-x', typeId: 'fir', title: 'T', status: 'draft', refNo: '',
    pages: [
      { uid: 'pg-1', sheetId: 'fir-main', values: {} },
      { uid: 'pg-2', sheetId: 'blank', doc: DOC, html: '' },
    ],
  }),
  saveReport: (r) => Promise.resolve(r),
  newReportId: () => 'rpt-x',
  downloadReportPdf: () => Promise.resolve(),
  aiPolish: () => Promise.resolve('x'),
  deleteReport: () => Promise.resolve({}),
}), { virtual: true });
jest.mock('../utils/investigation', () => ({ listInvestigations: () => Promise.resolve([]) }), { virtual: true });
jest.mock('../utils/audit', () => ({ logAudit: () => {} }), { virtual: true });
jest.mock('../components/TopBar', () => ({ __esModule: true, default: () => null }), { virtual: true });

const ReportEditor = require('../pages/ReportEditor').default;
const { ConfirmProvider } = require('../components/ConfirmDialog');

test('editor mounts statutory sheet + document page with a text box', async () => {
  render(<ConfirmProvider><ReportEditor /></ConfirmProvider>);
  await screen.findByText(/boxed text/i, {}, { timeout: 15000 });
  await screen.findByText(/FIRST INFORMATION REPORT/i, {}, { timeout: 15000 });
}, 30000);
