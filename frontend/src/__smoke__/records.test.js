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
  uploadScan: (...a) => global.__upload(...a),
  newBatchId: () => 'batch-1',
  isPdf: () => false,
  recordsToCsv: (rows) => `Title\n${rows.map((r) => r.title).join('\n')}`,
  searchRecords: () => Promise.resolve([]),
}), { virtual: true });
jest.mock('../utils/audit', () => ({ logAudit: () => {} }), { virtual: true });
jest.mock('../components/TopBar', () => ({ __esModule: true, default: () => null }), { virtual: true });

global.__records = RECORDS;
global.__upload = () => Promise.resolve({ id: 'rec-3' });

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

test('file types get the right badge', () => {
  const { badgeFor } = require('../pages/Records');
  expect(badgeFor('statement.PDF').label).toBe('PDF');
  expect(badgeFor('scan.jpeg')).toEqual({ label: 'JPEG', hue: 0 });
  expect(badgeFor('ledger.xlsx')).toEqual({ label: 'XLSX', hue: 1 });
  expect(badgeFor('interview.m4a').label).toBe('M4A');
  expect(badgeFor('mystery.zzz')).toEqual({ label: 'ZZZ', hue: 4 });
  expect(badgeFor('noextension').label).toBe('FILE');
});

test('a failed page upload can be retried in place', async () => {
  URL.createObjectURL = () => 'blob:x';
  URL.revokeObjectURL = () => {};
  let calls = 0;
  global.__upload = () => (++calls === 1
    ? Promise.reject(new Error('Upload failed — connection lost'))
    : Promise.resolve({ id: 'rec-9' }));

  const { container } = render(<ConfirmProvider><Records /></ConfirmProvider>);
  await screen.findByText('FIR 42/2026');
  const input = container.querySelector('input[type="file"]:not([capture])');
  fireEvent.change(input, { target: { files: [new File(['x'], 'page.png', { type: 'image/png' })] } });
  fireEvent.click(await screen.findByRole('button', { name: /save/i }));

  await screen.findByText('Upload failed — connection lost');
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  await screen.findByLabelText('Done');
  expect(calls).toBe(2);
  expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  global.__upload = () => Promise.resolve({ id: 'rec-3' });
});
