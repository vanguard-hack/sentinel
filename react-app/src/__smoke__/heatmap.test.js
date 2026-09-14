import { columnsFromDays, rowOf, utcDay } from '../components/charts/Heatmap';

const DAY = 86400000;
const utc = (y, m, d) => Date.UTC(y, m, d);
const series = (from, n) => Array.from({ length: n }, (_, i) => ({
  ts: from + i * DAY,
  value: i === 0 ? 3 : 0,
}));

test('a Monday is row 0 of a Monday-first grid', () => {
  // 6 Jan 2025 is a Monday.
  expect(rowOf(utc(2025, 0, 6))).toBe(0);
  expect(rowOf(utc(2025, 0, 12))).toBe(6); // Sunday
});

test('utcDay drops the time-of-day so two FIRs on the same date share a cell', () => {
  expect(utcDay(Date.parse('2025-04-12T09:00:00Z'))).toBe(utc(2025, 3, 12));
  expect(utcDay(Date.parse('2025-04-12T23:59:00Z'))).toBe(utc(2025, 3, 12));
});

test('365 consecutive days pack into week columns without dropping a day', () => {
  const days = series(utc(2024, 3, 12), 365);
  const cols = columnsFromDays(days);
  const counted = cols.flatMap((c) => c.bins).filter((b) => b.count != null);
  expect(counted).toHaveLength(365);
  expect(counted[0].count).toBe(3);
  expect(counted[1].count).toBe(0);
});

test('a year that does not start on Monday still begins on that Monday\'s column', () => {
  // 1 Jan 2025 is a Wednesday — row 2. The first column should still have
  // Monday/Tuesday as out-of-range (count null), not as zero-crime days.
  const days = series(utc(2025, 0, 1), 7);
  const cols = columnsFromDays(days);
  expect(cols[0].bins[0].count).toBeNull(); // Mon 30 Dec 2024
  expect(cols[0].bins[1].count).toBeNull(); // Tue 31 Dec
  expect(cols[0].bins[2].count).toBe(3);    // Wed 1 Jan
});
