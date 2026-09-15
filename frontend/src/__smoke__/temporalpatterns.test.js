/* Two new Temporal Patterns visualizations: a weekday x hour heatmap, and a
 * yearly volume series with a linear-trend forecast for the next couple of
 * years. Both build on the same {hour, weekday, month} row shape
 * fetchIncidents() already produces.
 */
import {
  weekdayHourMatrix, yearlySeries, forecastYears, completePartialYear, illustrativeHistory,
} from '../utils/aianalytics';

const row = (weekday, hour) => ({ weekday, hour, dayOfMonth: 1, month: '2025-01', head: '1' });

test('weekdayHourMatrix covers all 7 days in calendar order, Sunday first', () => {
  const grid = weekdayHourMatrix([]);
  expect(grid).toHaveLength(7);
  expect(grid[0].day).toBe('Sunday');
  expect(grid[6].day).toBe('Saturday');
  expect(grid.every((d) => d.cells.length === 24)).toBe(true);
});

test('weekdayHourMatrix counts land in the right day and hour cell', () => {
  const rows = [row(1, 9), row(1, 9), row(1, 14), row(5, 22)]; // Monday 09:00 x2, Monday 14:00, Friday 22:00
  const grid = weekdayHourMatrix(rows);
  expect(grid[1].cells[9]).toBe(2);
  expect(grid[1].cells[14]).toBe(1);
  expect(grid[1].total).toBe(3);
  expect(grid[5].cells[22]).toBe(1);
  expect(grid[0].total).toBe(0); // Sunday untouched
});

test('a row with a non-finite weekday or hour is skipped, not miscounted', () => {
  const grid = weekdayHourMatrix([{ weekday: NaN, hour: 9 }, { weekday: 2, hour: NaN }]);
  expect(grid.every((d) => d.total === 0)).toBe(true);
});

const monthRow = (ym) => ({ month: ym, hour: 0, weekday: 0, dayOfMonth: 1, head: '1' });
const yearOfMonths = (year, count) =>
  Array.from({ length: count }, (_, i) => monthRow(`${year}-${String(i + 1).padStart(2, '0')}`));

test('yearlySeries sums monthly counts per year and flags a short year as incomplete', () => {
  // 2023 and 2024 get all 12 months (1 incident each = 12 total); 2025 only
  // gets 6 (Jan-Jun) — a partial year, same as this dataset's real shape.
  const rows = [...yearOfMonths(2023, 12), ...yearOfMonths(2024, 12), ...yearOfMonths(2025, 6)];
  const series = yearlySeries(rows);
  expect(series).toEqual([
    { year: '2023', value: 12, complete: true },
    { year: '2024', value: 12, complete: true },
    { year: '2025', value: 6, complete: false },
  ]);
});

test('forecastYears fits a trend on complete years only, and skips the partial year it\'s next to', () => {
  // Complete years rising by 10/year: 100, 110, 120. Partial 2026 sits next
  // in the series but must not be re-predicted — the forecast should start
  // at 2027, not 2026.
  const series = [
    { year: '2023', value: 100, complete: true },
    { year: '2024', value: 110, complete: true },
    { year: '2025', value: 120, complete: true },
    { year: '2026', value: 55, complete: false },
  ];
  const { points, slope } = forecastYears(series, 2);
  expect(slope).toBeCloseTo(10, 6);
  expect(points.map((p) => p.year)).toEqual(['2027', '2028']);
  expect(points[0].value).toBe(140); // one full step past 2025's fitted 130
  expect(points[1].value).toBe(150);
  expect(points.every((p) => p.forecast)).toBe(true);
});

test('forecastYears needs at least 2 complete years, and never predicts below zero', () => {
  expect(forecastYears([{ year: '2023', value: 50, complete: true }])).toEqual({ points: [], slope: 0 });
  expect(forecastYears([])).toEqual({ points: [], slope: 0 });

  const declining = [
    { year: '2023', value: 20, complete: true },
    { year: '2024', value: 5, complete: true },
  ];
  const { points } = forecastYears(declining, 3);
  expect(points.every((p) => p.value >= 0)).toBe(true);
});

test('completePartialYear tops up the trailing partial year with the model\'s remaining months', () => {
  const series = [
    { year: '2025', value: 1200, complete: true },
    { year: '2026', value: 600, complete: false }, // Jan-Jun actual
  ];
  const modelSeries = {
    forecast: [
      { month: '2026-07', value: 100 },
      { month: '2026-08', value: 110 },
      { month: '2027-01', value: 999 }, // a different year — must not leak in
    ],
  };
  const { series: out, modelCompleted } = completePartialYear(series, modelSeries);
  expect(modelCompleted).toBe(true);
  expect(out).toEqual([
    { year: '2025', value: 1200, complete: true },
    { year: '2026', value: 810, complete: false }, // 600 + 100 + 110
  ]);
});

test('completePartialYear is a no-op when the trailing year is already complete', () => {
  const series = [{ year: '2025', value: 1200, complete: true }];
  const result = completePartialYear(series, { forecast: [{ month: '2026-01', value: 50 }] });
  expect(result).toEqual({ series, modelCompleted: false });
});

test('completePartialYear is a no-op with no model series, or one with no forecast for that year', () => {
  const series = [{ year: '2026', value: 600, complete: false }];
  expect(completePartialYear(series, null)).toEqual({ series, modelCompleted: false });
  expect(completePartialYear(series, { forecast: [{ month: '2027-01', value: 50 }] }))
    .toEqual({ series, modelCompleted: false });
});

test('illustrativeHistory prepends the requested number of years, ending right before the first real year', () => {
  const series = [{ year: '2023', value: 1000, complete: true }];
  const lead = illustrativeHistory(series, 13);
  expect(lead).toHaveLength(13);
  expect(lead.map((p) => p.year)).toEqual(
    Array.from({ length: 13 }, (_, i) => String(2023 - 13 + i)) // 2010..2022, ascending
  );
  expect(lead.every((p) => p.illustrative)).toBe(true);
});

test('illustrativeHistory values stay bounded and non-negative around the first real year\'s level', () => {
  const series = [{ year: '2023', value: 1000, complete: true }];
  const lead = illustrativeHistory(series, 13);
  lead.forEach((p) => {
    expect(p.value).toBeGreaterThanOrEqual(0);
    expect(p.value).toBeLessThanOrEqual(1360); // anchor * 1.35, with rounding slack
    expect(p.value).toBeGreaterThanOrEqual(640); // anchor * 0.65, with rounding slack
  });
});

test('illustrativeHistory correlates consecutive years instead of drawing each independently', () => {
  // An AR(1) walk carries most of the previous year's deviation forward, so
  // a year almost never lands more than half its own clamped range away
  // from its neighbour. Independent draws (the old behaviour) have no such
  // constraint and would fail this on a large enough seed sweep.
  const series = [{ year: '2023', value: 1000, complete: true }];
  const lead = illustrativeHistory(series, 13);
  for (let i = 1; i < lead.length; i++) {
    expect(Math.abs(lead[i].value - lead[i - 1].value)).toBeLessThanOrEqual(400);
  }
});

test('illustrativeHistory is deterministic for the same seed, and empty with no series to anchor on', () => {
  const series = [{ year: '2023', value: 1000, complete: true }];
  expect(illustrativeHistory(series, 5, 42)).toEqual(illustrativeHistory(series, 5, 42));
  expect(illustrativeHistory([])).toEqual([]);
});
