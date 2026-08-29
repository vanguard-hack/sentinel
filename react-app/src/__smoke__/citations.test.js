import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('react-router-dom', () => ({
  Link: ({ to, children, ...rest }) => <a href={to} {...rest}>{children}</a>,
}), { virtual: true });

jest.mock('../utils/digitise', () => ({
  getRecord: (id) => (global.__recordDenied
    ? Promise.reject(new Error('Investigator, supervisor or admin access required'))
    : Promise.resolve({
      id, title: 'Seizure memo', docType: 'Seizure Memo', filename: 'memo.jpg',
      sourceKind: 'scan', key: 'digitise/files/rec-1.jpg',
      text: 'SEIZURE MEMO — one motorcycle KA01AB1234 recovered.',
    })),
  fetchScanUrl: () => Promise.resolve('data:image/jpeg;base64,AAA'),
  fetchFileUrl: () => Promise.resolve({ url: 'blob:x', mime: 'audio/mp4', bytes: 10 }),
}), { virtual: true });

const SourceCitations = require('../components/SourceCitations').default;
const { SourceViewer } = require('../components/SourceCitations');
const { normaliseSources, isOpenable } = require('../utils/sources');
const RichText = require('../components/RichText').default;

const RAW = [
  {
    source_id: 'src_01', source_type: 'rag_document',
    display_name: 'SOP_Arrest_and_Impound_v3.pdf', location: 'Page 12',
    collection: 'Knowledge base',
    passages: [{ location: 'Page 12', excerpt: 'Impounded vehicles shall be entered in the station register.' }],
  },
  {
    source_id: 'src_02', source_type: 'database_record', display_name: 'CaseMaster',
    identifier: '2 records', scope: 'Catalyst DataStore (ZCQL Read-Only)',
    filter_applied: "District = 'Bengaluru City'",
    matched_record_ids: ['4029', '4030'],
    records: [{ CaseMasterID: 4029, District: 'Bengaluru City' }],
    query: "SELECT * FROM CaseMaster WHERE District = 'Bengaluru City'",
  },
  {
    source_id: 'src_03', source_type: 'external_web',
    display_name: 'Ministry of Home Affairs guidelines',
    uri: 'https://mha.gov.in/guidelines/vehicle-seizure-protocol', domain: 'mha.gov.in',
  },
  {
    source_id: 'src_04', source_type: 'vision_extraction', display_name: 'Zia Vision OCR',
    identifier: 'Vehicle_Plate_Scan_img01.jpg', extracted_field: 'vehicle no: KA01AB1234',
    fields: [{ key: 'vehicle no', value: 'KA01AB1234' }],
    passages: [{ excerpt: 'REGISTRATION CERTIFICATE' }],
  },
  {
    source_id: 'src_05', source_type: 'rag_document', display_name: 'Seizure memo (memo.jpg)',
    location: 'Scanned paper, read by OCR', record_id: 'rec-1', collection: 'Digitised records',
    passages: [{ excerpt: 'one motorcycle KA01AB1234 recovered' }],
  },
];

const sources = normaliseSources(RAW);

test('every citation type renders a numbered chip', () => {
  render(<SourceCitations sources={sources} onOpen={() => {}} />);
  expect(screen.getByText('Sources')).toBeTruthy();
  ['1', '2', '3', '4', '5'].forEach((n) => expect(screen.getByText(n)).toBeTruthy());
  expect(screen.getByText('SOP_Arrest_and_Impound_v3.pdf')).toBeTruthy();
  expect(screen.getByText('CaseMaster')).toBeTruthy();
  expect(screen.getByText('Zia Vision OCR')).toBeTruthy();
});

test('a web citation opens in a severed new tab rather than calling back', () => {
  const onOpen = jest.fn();
  render(<SourceCitations sources={sources} onOpen={onOpen} />);
  const link = screen.getByText('Ministry of Home Affairs guidelines').closest('a');
  expect(link.getAttribute('href')).toBe('https://mha.gov.in/guidelines/vehicle-seizure-protocol');
  expect(link.getAttribute('target')).toBe('_blank');
  // The security requirement: the opened page must not reach back into this
  // window, and must not carry the officer's page as a referrer.
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  fireEvent.click(link);
  expect(onOpen).not.toHaveBeenCalled();
});

test('clicking a document chip asks for that citation by number', () => {
  const onOpen = jest.fn();
  render(<SourceCitations sources={sources} onOpen={onOpen} />);
  fireEvent.click(screen.getByText('SOP_Arrest_and_Impound_v3.pdf').closest('button'));
  expect(onOpen).toHaveBeenCalledWith(1);
});

test('a legacy string citation is shown but is not a button', () => {
  const legacy = normaliseSources(['Data Store: CaseMaster', 'Digitised record: memo.jpg']);
  expect(isOpenable(legacy[0])).toBe(false);
  const { container } = render(<SourceCitations sources={legacy} onOpen={() => {}} />);
  expect(screen.getByText('CaseMaster')).toBeTruthy();
  expect(container.querySelectorAll('button').length).toBe(0);
});

test('the record drawer shows the filter, the matched ids and the rows', () => {
  render(<SourceViewer source={sources[1]} onClose={() => {}} />);
  expect(screen.getByText("District = 'Bengaluru City'")).toBeTruthy();
  expect(screen.getByText('4029, 4030')).toBeTruthy();
  expect(screen.getByText('Catalyst DataStore (ZCQL Read-Only)')).toBeTruthy();
  expect(screen.getByText('Bengaluru City')).toBeTruthy();
});

test('a saved conversation says its rows were not kept, not that none matched', () => {
  const trimmed = normaliseSources([{ ...RAW[1], records: undefined, records_trimmed: true }]);
  render(<SourceViewer source={trimmed[0]} onClose={() => {}} />);
  expect(screen.getByText(/not kept in saved conversations/i)).toBeTruthy();
  expect(screen.queryByText(/computed over the table/i)).toBeFalsy();
});

test('a knowledge-base citation shows the passage that was retrieved', () => {
  render(<SourceViewer source={sources[0]} onClose={() => {}} />);
  expect(screen.getByText(/Impounded vehicles shall be entered/)).toBeTruthy();
});

test('a digitised citation opens the record itself', async () => {
  global.__recordDenied = false;
  render(<SourceViewer source={sources[4]} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByAltText(/Page 1 of Seizure memo/i)).toBeTruthy());
  expect(screen.getByText(/Open the full record/i).closest('a').getAttribute('href')).toBe('/records/rec-1');
});

test('a record the officer may not open says so instead of failing silently', async () => {
  global.__recordDenied = true;
  render(<SourceViewer source={sources[4]} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText(/could not be opened/i)).toBeTruthy());
  global.__recordDenied = false;
});

test('a vision citation shows the extracted field and the text read', () => {
  render(<SourceViewer source={sources[3]} onClose={() => {}} />);
  expect(screen.getByText('KA01AB1234')).toBeTruthy();
  expect(screen.getByText('REGISTRATION CERTIFICATE')).toBeTruthy();
});

test('Escape closes the viewer', () => {
  const onClose = jest.fn();
  render(<SourceViewer source={sources[0]} onClose={onClose} />);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
});

test('an inline [1] marker becomes a clickable footnote', () => {
  const onCitation = jest.fn();
  render(<RichText text="The vehicle was impounded [1] at 14:30 hrs." citationCount={2} onCitation={onCitation} />);
  fireEvent.click(screen.getByTitle('Open source 1'));
  expect(onCitation).toHaveBeenCalledWith(1);
});

test('a marker with no source behind it stays plain text', () => {
  const { container } = render(
    <RichText text="Reported in [7] earlier filings." citationCount={2} onCitation={() => {}} />
  );
  expect(container.querySelectorAll('.rf-cite').length).toBe(0);
  expect(container.textContent).toContain('[7]');
});

test('prose with no citations renders exactly as before', () => {
  const { container } = render(<RichText text="A plain **answer** with no sources." />);
  expect(container.querySelector('strong').textContent).toBe('answer');
  expect(container.querySelectorAll('button').length).toBe(0);
});
