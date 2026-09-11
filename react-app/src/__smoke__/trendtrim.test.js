/* trendSeries trims a trailing run of zero-value points — a window that
 * extends past whatever the dataset was actually generated up to (or into a
 * not-yet-complete period) must not draw that as a real cliff down to zero
 * at the chart's right edge.
 */
import { trendSeries } from '../utils/reports';

const day = 86400000;
const isoDays = (start, count) => {
  const out = [];
  for (let i = 0; i < count; i++) out.push(new Date(start + i * day).toISOString().slice(0, 10));
  return out;
};

test('a trailing run of days with no data is trimmed off the end', () => {
  const from = Date.UTC(2026, 0, 1);
  const to = from + 29 * day; // 30-day window -> daily bucket
  // Cases only on the first 20 days; days 21-30 have nothing.
  const dates = isoDays(from, 20);
  const { points } = trendSeries(dates, from, to);
  expect(points.length).toBe(20);
  expect(points[points.length - 1].value).toBeGreaterThan(0);
});

test('a zero gap in the MIDDLE of the window is kept, not trimmed', () => {
  const from = Date.UTC(2026, 0, 1);
  const to = from + 9 * day; // 10-day window
  // Data on day 0 and day 9 only — days 1-8 are a real gap, not the edge.
  const dates = [
    new Date(from).toISOString().slice(0, 10),
    new Date(to).toISOString().slice(0, 10),
  ];
  const { points } = trendSeries(dates, from, to);
  expect(points.length).toBe(10);
  expect(points[points.length - 1].value).toBeGreaterThan(0);
});

test('a window with no data at all is never trimmed to nothing', () => {
  const from = Date.UTC(2026, 0, 1);
  const to = from + 9 * day;
  const { points } = trendSeries([], from, to);
  expect(points.length).toBe(10);
  expect(points.every((p) => p.value === 0)).toBe(true);
});

test('the same trim applies to the monthly bucket for a longer window', () => {
  const from = Date.UTC(2025, 0, 1); // > 62 days, < 400 days -> monthly bucket
  const to = Date.UTC(2025, 8, 30); // Jan..Sep, 9 months
  // Cases only through June — July, August, September have nothing.
  const dates = isoDays(from, 150); // Jan 1 - ~end of May
  const { points } = trendSeries(dates, from, to);
  expect(points.length).toBeLessThan(9);
  expect(points[points.length - 1].value).toBeGreaterThan(0);
});
