import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('react-router-dom', () => ({
  Link: ({ to, children, ...rest }) => <a href={to} {...rest}>{children}</a>,
}), { virtual: true });

// One record shape per test: the viewer renders a scan, a filed document, a
// PDF and a recording completely differently, and each of those paths is the
// feature.
const SCAN = {
  id: 'rec-1', title: 'Seizure memo', docType: 'Seizure Memo', filename: 'memo.jpg',
  sourceKind: 'scan', key: 'digitise/files/rec-1.jpg',
  text: 'SEIZURE MEMO\n\nOne motorcycle KA01AB1234 was recovered from the accused.\n\nSigned, PSI Rao.',
};
jest.mock('../utils/digitise', () => ({
  getRecord: (id) => (global.__recordDenied
    ? Promise.reject(new Error('Investigator, supervisor or admin access required'))
    : Promise.resolve({ ...(global.__record || global.__SCAN), id })),
  fetchScanUrl: (k) => Promise.resolve(`data:image/jpeg;base64,${k}`),
  fetchFileUrl: () => Promise.resolve(global.__file || { url: 'blob:x', mime: 'audio/mp4', bytes: 10 }),
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
    passages: [{ excerpt: 'One motorcycle KA01AB1234 was recovered from the accused.' }],
  },
];

const sources = normaliseSources(RAW);

global.__SCAN = SCAN;
beforeEach(() => {
  global.__record = SCAN;
  global.__file = null;
  global.__recordDenied = false;
});

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

// ── Opening the source itself ──────────────────────────────────────────────

const { locatePassage } = require('../utils/sources');

test('the cited passage is found inside the document text', () => {
  const body = 'SEIZURE MEMO\n\nOne motorcycle KA01AB1234 was recovered.\n\nSigned.';
  const at = locatePassage(body, 'One motorcycle KA01AB1234 was recovered.');
  expect(body.slice(at.start, at.end)).toBe('One motorcycle KA01AB1234 was recovered.');
});

test('a passage truncated for storage still locates its opening', () => {
  const body = 'Preamble. One motorcycle KA01AB1234 was recovered from the accused at 14:30 hrs.';
  const at = locatePassage(body, 'One motorcycle KA01AB1234 was recovered from the acc');
  expect(at.start).toBe(body.indexOf('One motorcycle'));
});

test('a passage re-wrapped since it was read is still located', () => {
  // An officer corrected the OCR and the line breaks moved; the words did not.
  const body = 'One   motorcycle\nKA01AB1234 was\trecovered from the accused.';
  const at = locatePassage(body, 'One motorcycle KA01AB1234 was recovered from the accused.');
  expect(at).not.toBeNull();
  expect(body.slice(at.start, at.end)).toContain('KA01AB1234');
});

test('a passage from a different document is not force-matched', () => {
  expect(locatePassage('Nothing to do with it.', 'One motorcycle KA01AB1234')).toBeNull();
});

test('the passage is highlighted in place, not just quoted above the text', async () => {
  const { container } = render(<SourceViewer source={sources[4]} onClose={() => {}} />);
  await waitFor(() => expect(container.querySelector('.as-src-mark')).toBeTruthy());
  expect(container.querySelector('.as-src-mark').textContent).toContain('KA01AB1234');
  expect(screen.getByText(/Highlighted: the passage/i)).toBeTruthy();
});

test('a multi-page scan loads a few pages, then the rest on request', async () => {
  global.__record = {
    ...SCAN,
    pages: [1, 2, 3, 4, 5].map((n) => ({ key: `digitise/files/rec-1-p${n}.jpg` })),
  };
  render(<SourceViewer source={sources[4]} onClose={() => {}} />);
  await waitFor(() => expect(screen.getAllByRole('img').length).toBe(3));
  expect(screen.getByText(/Page 1 of 5/)).toBeTruthy();
  fireEvent.click(screen.getByText(/Show the remaining 2 pages/));
  await waitFor(() => expect(screen.getAllByRole('img').length).toBe(5));
});

test('a filed office document offers the original alongside its text', async () => {
  global.__record = {
    ...SCAN, title: 'Property list', filename: 'property.xlsx', sourceKind: 'sheet',
    key: 'digitise/files/rec-1.xlsx', sourceBytes: 24000,
    summary: 'Seized property, itemised.',
    fields: { 'Crime No.': '0042/2026' },
    tables: [{ title: 'Property', columns: ['Item', 'Value'], rows: [['Phone', '18000']] }],
  };
  global.__file = { url: 'blob:sheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 24000 };
  render(<SourceViewer source={sources[4]} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText(/Open the original file/)).toBeTruthy());
  // The content itself is in the panel, not just a pointer to it.
  expect(screen.getByText('Seized property, itemised.')).toBeTruthy();
  expect(screen.getByText('0042/2026')).toBeTruthy();
  expect(screen.getByText('Phone')).toBeTruthy();
  expect(screen.getByText('18000')).toBeTruthy();
});

test('a stored PDF renders in the viewer rather than being described', async () => {
  global.__record = {
    ...SCAN, title: 'Charge sheet', filename: 'chargesheet.pdf', sourceKind: 'word',
    key: 'digitise/files/rec-1.pdf',
  };
  global.__file = { url: 'blob:pdf', mime: 'application/pdf', bytes: 90000 };
  const { container } = render(<SourceViewer source={sources[4]} onClose={() => {}} />);
  await waitFor(() => expect(container.querySelector('iframe.as-src-pdf')).toBeTruthy());
  expect(container.querySelector('iframe.as-src-pdf').getAttribute('src')).toBe('blob:pdf');
});

test('a recording plays, with its transcript beside it', async () => {
  global.__record = {
    ...SCAN, title: 'Complainant statement', filename: 'rec.m4a', sourceKind: 'audio',
    key: 'digitise/files/rec-1.m4a', text: 'He said the motorcycle was taken at night.',
  };
  global.__file = { url: 'blob:audio', mime: 'audio/mp4', bytes: 500000 };
  const { container } = render(<SourceViewer source={sources[4]} onClose={() => {}} />);
  await waitFor(() => expect(container.querySelector('audio.as-src-media')).toBeTruthy());
  expect(screen.getByText('Transcript')).toBeTruthy();
});

test('a digitised chip carries a direct jump to the record page', () => {
  const { container } = render(<SourceCitations sources={sources} onOpen={() => {}} />);
  const jump = container.querySelector('.as-cite-jump');
  expect(jump.getAttribute('href')).toBe('/records/rec-1');
});

test('a web citation shows its full address, not just the site', () => {
  render(<SourceCitations sources={sources} onOpen={() => {}} />);
  expect(screen.getByText('https://mha.gov.in/guidelines/vehicle-seizure-protocol')).toBeTruthy();
});

test('a knowledge-base document that publishes a URL offers to open it', () => {
  const withUrl = normaliseSources([{
    ...RAW[0], uri: 'https://indiacode.nic.in/handle/123/456',
  }]);
  render(<SourceViewer source={withUrl[0]} onClose={() => {}} />);
  const open = screen.getByText(/Open the document/).closest('a');
  expect(open.getAttribute('href')).toBe('https://indiacode.nic.in/handle/123/456');
  expect(open.getAttribute('rel')).toBe('noopener noreferrer');
});

test('a knowledge-base document with no file says so rather than offering a dead link', () => {
  const { container } = render(<SourceViewer source={sources[0]} onClose={() => {}} />);
  expect(screen.getByText(/held in the knowledge base rather than in Sentinel/i)).toBeTruthy();
  expect(container.querySelector('.as-src-open')).toBeFalsy();
});
