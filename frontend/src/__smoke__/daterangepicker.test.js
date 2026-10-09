// frontend/src/__smoke__/daterangepicker.test.js
//
// The comparison period is the part of DateRangePicker that is arithmetic
// rather than react-aria behaviour, so it is what this pins down; the rest is
// one end-to-end pass through preset → compare → Apply.
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { parseDate, today, getLocalTimeZone } from '@internationalized/date';
import DateRangePicker, { compareRange } from '../components/ui/DateRangePicker';

const r = (s, e) => ({ start: parseDate(s), end: parseDate(e) });
const str = (x) => x && `${x.start} ${x.end}`;

test('previous period is the same length, ending the day before', () => {
  expect(str(compareRange(r('2026-09-10', '2026-10-09'), 'previous'))).toBe('2026-08-11 2026-09-09');
  expect(str(compareRange(r('2026-03-01', '2026-03-01'), 'previous'))).toBe('2026-02-28 2026-02-28');
});

test('previous year shifts both ends back a year (Feb 29 clamps)', () => {
  expect(str(compareRange(r('2026-09-01', '2026-09-30'), 'year'))).toBe('2025-09-01 2025-09-30');
  expect(str(compareRange(r('2028-02-29', '2028-03-05'), 'year'))).toBe('2027-02-28 2027-03-05');
});

test('compare off yields no comparison range', () => {
  expect(compareRange(r('2026-09-01', '2026-09-30'), 'off')).toBeNull();
});

test('preset + previous period applies both ranges', async () => {
  const onChange = jest.fn();
  render(<DateRangePicker value={{ start: '2026-01-01', end: '2026-01-05' }} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: /date range/i }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Last 7 days' }));
  fireEvent.click(within(dialog).getByRole('radio', { name: 'Previous period' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));

  const t = today(getLocalTimeZone());
  expect(onChange).toHaveBeenCalledWith(
    { start: t.subtract({ days: 6 }).toString(), end: t.toString() },
    { start: t.subtract({ days: 13 }).toString(), end: t.subtract({ days: 7 }).toString() },
    'previous',
  );
});
