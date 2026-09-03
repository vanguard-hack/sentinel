// Incidents pages ten at a time.
//
// The list renders a full FIR record per row, so the page size is not a
// cosmetic choice — thirty rows open into thirty case files. This asserts the
// behaviour an officer sees: ten rows, arrows that move, a count that tells
// the truth, and a filter that returns them to the first page rather than
// stranding them on a page that no longer exists.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

const mockIncidents = Array.from({ length: 34 }, (_, i) => ({
  id: `i${i}`,
  crimeNo: `CR/${String(i + 1).padStart(3, '0')}/2026`,
  crimeType: i % 2 ? 'Theft' : 'Assault',
  crimeHead: 'Body offences',
  station: 'Station A',
  district: 'Bengaluru',
  status: i % 3 === 0 ? 'Convicted' : 'Under Investigation',
  registeredDate: '2026-04-01T10:00',
  complainants: [], victims: [], accused: [], sections: [], arrests: [],
}));

jest.mock('../utils/incidents', () => ({
  fetchIncidents: () => Promise.resolve(mockIncidents),
}), { virtual: true });
jest.mock('../components/TopBar', () => ({ __esModule: true, default: () => null }), { virtual: true });
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k }),
}), { virtual: true });

const Incidents = require('../pages/Incidents').default;

const rows = () => screen.getAllByText(/^CR\/\d{3}\/2026$/).map((n) => n.textContent);

test('a page holds ten incidents, not the whole list', async () => {
  render(<Incidents />);
  await screen.findByText('CR/001/2026');
  expect(rows()).toHaveLength(10);
  expect(screen.queryByText('CR/011/2026')).toBeNull();
});

test('the arrows move through the pages and stop at both ends', async () => {
  render(<Incidents />);
  await screen.findByText('CR/001/2026');
  const prev = screen.getByLabelText('common.prevPage');
  const next = screen.getByLabelText('common.nextPage');

  expect(prev.disabled).toBe(true);           // nothing before the first page
  fireEvent.click(next);
  expect(rows()[0]).toBe('CR/011/2026');
  expect(prev.disabled).toBe(false);

  fireEvent.click(next);
  fireEvent.click(next);                       // 34 rows → four pages
  expect(rows()).toHaveLength(4);              // the last page is the remainder
  expect(next.disabled).toBe(true);

  fireEvent.click(prev);
  expect(rows()[0]).toBe('CR/021/2026');
});

test('the count describes the page, not the fetch', async () => {
  render(<Incidents />);
  await screen.findByText('CR/001/2026');
  expect(screen.getByText('1–10 of 34')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('common.nextPage'));
  expect(screen.getByText('11–20 of 34')).toBeTruthy();
});

test('a filter returns to the first page instead of stranding the officer', async () => {
  render(<Incidents />);
  await screen.findByText('CR/001/2026');
  fireEvent.click(screen.getByLabelText('common.nextPage'));
  fireEvent.click(screen.getByLabelText('common.nextPage'));
  expect(rows()[0]).toBe('CR/021/2026');

  // 12 of the 34 are Convicted — fewer than the page the officer was on.
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Convicted' } });
  expect(rows()[0]).toBe('CR/001/2026');
  expect(screen.getByText('1–10 of 12')).toBeTruthy();
});

test('a result set that fits on one page shows no pager at all', async () => {
  render(<Incidents />);
  await screen.findByText('CR/001/2026');
  fireEvent.change(screen.getByPlaceholderText(/Search crime no/i), { target: { value: 'CR/007' } });
  expect(rows()).toEqual(['CR/007/2026']);
  expect(screen.queryByLabelText('common.nextPage')).toBeNull();
});
