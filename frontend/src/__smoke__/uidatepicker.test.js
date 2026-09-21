// frontend/src/__smoke__/uidatepicker.test.js
//
// DateRangeCalendar was a hand-rolled month grid; this replaces it with
// react-aria-components' RangeCalendar plus a quick-select preset list, kept
// behind the exact same from/to/onSelect contract so Reports.js's Apply/
// Clear/calOpen state doesn't have to change.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { today, getLocalTimeZone } from '@internationalized/date';
import DatePicker from '../components/ui/DatePicker';

// `new Date().toISOString()` reads the UTC date, but DatePicker (like the
// rest of this test file's "current date" checks) computes "today" in the
// browser's local timezone via `today(getLocalTimeZone())` — the two
// disagree for part of every day in any timezone ahead of UTC (this app
// runs in Asia/Kolkata, UTC+5:30), which made these assertions flaky rather
// than wrong. Using the same @internationalized/date call the component
// itself uses keeps the test's notion of "today" identical to the code
// under test, regardless of timezone or when in the day the suite runs.
const todayIso = () => today(getLocalTimeZone()).toString();

test('picking the "Today" preset calls onSelect with today as both ends', () => {
  const onSelect = jest.fn();
  render(<DatePicker from={null} to={null} onSelect={onSelect} />);
  // Exact match: react-aria's own "today" grid cell also has "Today" in its
  // aria-label (e.g. "Today, Monday, September 21, 2026"), which a loose
  // /today/i regex would also match, so this must target the preset button
  // by its exact accessible name.
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  const iso = todayIso();
  expect(onSelect).toHaveBeenCalledWith({ from: iso, to: iso });
});

test('an existing range is reflected in the calendar selection', () => {
  render(<DatePicker from="2026-01-01" to="2026-01-05" onSelect={() => {}} />);
  // The grid renders at least the start date's cell as selected.
  expect(document.querySelector('[aria-selected="true"]')).toBeInTheDocument();
});

test('the "This year" preset spans Jan 1 of the current year through today', () => {
  const onSelect = jest.fn();
  render(<DatePicker from={null} to={null} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('button', { name: 'This year' }));
  const jan1 = `${new Date().getFullYear()}-01-01`;
  expect(onSelect).toHaveBeenCalledWith({ from: jan1, to: todayIso() });
});

test('the "Last year" preset spans all of the previous calendar year', () => {
  const onSelect = jest.fn();
  render(<DatePicker from={null} to={null} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('button', { name: 'Last year' }));
  const lastYear = new Date().getFullYear() - 1;
  expect(onSelect).toHaveBeenCalledWith({ from: `${lastYear}-01-01`, to: `${lastYear}-12-31` });
});

test('the "Last 12 months" preset runs from 12 months ago through today', () => {
  const onSelect = jest.fn();
  render(<DatePicker from={null} to={null} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('button', { name: 'Last 12 months' }));
  const iso = todayIso();
  const called = onSelect.mock.calls[0][0];
  expect(called.to).toBe(iso);
  expect(called.from < iso).toBe(true);
});
