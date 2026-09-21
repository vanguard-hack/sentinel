// frontend/src/__smoke__/uidatepicker.test.js
//
// DateRangeCalendar was a hand-rolled month grid; this replaces it with
// react-aria-components' RangeCalendar plus a quick-select preset list, kept
// behind the exact same from/to/onSelect contract so Reports.js's Apply/
// Clear/calOpen state doesn't have to change.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import DatePicker from '../components/ui/DatePicker';

test('picking the "Today" preset calls onSelect with today as both ends', () => {
  const onSelect = jest.fn();
  render(<DatePicker from={null} to={null} onSelect={onSelect} />);
  // Exact match: react-aria's own "today" grid cell also has "Today" in its
  // aria-label (e.g. "Today, Monday, September 21, 2026"), which a loose
  // /today/i regex would also match, so this must target the preset button
  // by its exact accessible name.
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  const today = new Date().toISOString().slice(0, 10);
  expect(onSelect).toHaveBeenCalledWith({ from: today, to: today });
});

test('an existing range is reflected in the calendar selection', () => {
  render(<DatePicker from="2026-01-01" to="2026-01-05" onSelect={() => {}} />);
  // The grid renders at least the start date's cell as selected.
  expect(document.querySelector('[aria-selected="true"]')).toBeInTheDocument();
});
