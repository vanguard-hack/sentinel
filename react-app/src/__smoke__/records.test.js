import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('react-router-dom', () => ({
  useParams: () => ({ recordId: 'rec-1' }),
  useNavigate: () => () => {},
}), { virtual: true });

const RECORDS = [
  { id: 'rec-1', title: 'FIR 42/2026', docType: 'FIR', summary: 'Theft at market road.',
    filename: 'page1.jpg', tableCount: 1, crimeNo: '0042/2026', status: 'processed',
    createdAt: Date.now(), uploadedByName: 'PSI Rao' },
  { id: 'rec-2', title: 'Seizure list', docType: 'Seizure Memo', summary: '',
    filename: 'page2.jpg', tableCount: 0, status: 'ocr-failed', createdAt: Date.now(), uploadedByName: 'PSI Rao' },
];

jest.mock('../utils/digitise', () => ({
  listRecords: () => Promise.resolve(global.__records),
  getRecord: () => Promise.resolve({
    id: 'rec-1', title: 'FIR 42/2026', docType: 'FIR', filename: 'page1.jpg', bytes: 120000,
    key: 'digitise/files/rec-1.jpg', summary: 'Theft at market road.',
    fields: { 'Crime No.': '0042/2026', 'Police Station': 'Ashok Nagar' },
    tables: [{ title: 'Property', columns: ['Item', 'Value'], rows: [['Phone', '18000']] }],
    text: 'FIR No 0042/2026 ...', status: 'processed',
  }),
  updateRecord: (p) => Promise.resolve({ ...p, fields: {}, tables: [], text: p.text || '' }),
  deleteRecord: () => Promise.resolve({}),
  fetchScanUrl: () => Promise.resolve('data:image/jpeg;base64,AAA'),
  uploadScan: () => Promise.resolve({ id: 'rec-3' }),
  newBatchId: () => 'batch-1',
  recordsToCsv: (rows) => `Title\n${rows.map((r) => r.title).join('\n')}`,
  searchRecords: () => Promise.resolve([]),
}), { virtual: true });
jest.mock('../utils/audit', () => ({ logAudit: () => {} }), { virtual: true });
jest.mock('../components/TopBar', () => ({ __esModule: true, default: () => null }), { virtual: true });

global.__records = RECORDS;

const Records = require('../pages/Records').default;
const RecordDetail = require('../pages/RecordDetail').default;
const { ConfirmProvider } = require('../components/ConfirmDialog');

test('gallery lists digitised records and flags unreadable scans', async () => {
  render(<ConfirmProvider><Records /></ConfirmProvider>);
  await screen.findByText('FIR 42/2026');
  expect(screen.getByText('Seizure list')).toBeTruthy();
  expect(screen.getByText('Text not read')).toBeTruthy();
});

test('search narrows the gallery', async () => {
  render(<ConfirmProvider><Records /></ConfirmProvider>);
  await screen.findByText('FIR 42/2026');
  fireEvent.change(screen.getByPlaceholderText(/Search titles/i), { target: { value: 'seizure' } });
  await waitFor(() => expect(screen.queryByText('FIR 42/2026')).toBeNull());
  expect(screen.getByText('Seizure list')).toBeTruthy();
});

test('detail shows extracted fields, tables and text', async () => {
  render(<ConfirmProvider><RecordDetail /></ConfirmProvider>);
  await screen.findByText('Key particulars');
  expect(screen.getByText('Ashok Nagar')).toBeTruthy();
  expect(screen.getByText('Property')).toBeTruthy();
  expect(screen.getByText('18000')).toBeTruthy();
  expect(screen.getByText(/FIR No 0042\/2026/)).toBeTruthy();
});
