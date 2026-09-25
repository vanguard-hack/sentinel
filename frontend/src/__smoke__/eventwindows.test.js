import { eventWindows, EVENT_CALENDAR } from '../utils/eventCalendar';

// The whole point of this module is that it must NOT report a festival effect
// that is really just the calendar month the festival falls in. The dataset
// carries a monthly seasonal index (October runs ~14% above average, more in
// some districts), so an annual-mean baseline would manufacture a "Dasara
// effect" out of October. These tests pin the month-held-constant baseline and
// the Poisson noise floor, which are the two things that keep it honest.

const DAY = 86400000;
const utc = (y, m, d) => Date.UTC(y, m - 1, d);

// Build a synthetic year of FIRs at a fixed daily rate, optionally with a
// multiplier applied to one month and/or a spike on a set of dates.
function build({ from, to, perDay = 10, monthFactor = {}, spikeDays = new Map() }) {
  const cases = [];
  for (let t = from; t <= to; t += DAY) {
    const d = new Date(t);
    const f = monthFactor[d.getUTCMonth() + 1] ?? 1;
    const n = Math.round(perDay * f * (spikeDays.get(t) ?? 1));
    for (let i = 0; i < n; i += 1) cases.push({ ts: t + 3600000 });
  }
  return cases;
}

const find = (rows, name) => rows.find((r) => r.name === name);

test('a month-wide seasonal lift is NOT reported as a festival effect', () => {
  // October is 40% busier than every other month, but nothing special happens
  // during Dasara itself. The month baseline must absorb all of it.
  const cases = build({
    from: utc(2024, 1, 1), to: utc(2025, 12, 31),
    perDay: 20, monthFactor: { 10: 1.4 },
  });
  const dasara = find(eventWindows(cases), 'Dasara');
  expect(dasara).toBeDefined();
  expect(Math.abs(dasara.deviation)).toBeLessThan(0.05);
  expect(dasara.verdict).toBe('noise');
  // ...while the naive annual comparison would have claimed a big effect.
  expect(dasara.vsAnnual).toBeGreaterThan(0.2);
});

test('a real spike confined to the window IS reported', () => {
  const spike = new Map();
  // 2024 Dasara is 12 October, window +/-4 days.
  for (let i = -4; i <= 4; i += 1) spike.set(utc(2024, 10, 12) + i * DAY, 2.5);
  for (let i = -4; i <= 4; i += 1) spike.set(utc(2025, 10, 2) + i * DAY, 2.5);
  const cases = build({
    from: utc(2024, 1, 1), to: utc(2025, 12, 31),
    perDay: 20, monthFactor: { 10: 1.4 }, spikeDays: spike,
  });
  const dasara = find(eventWindows(cases), 'Dasara');
  expect(dasara.verdict).toBe('above');
  expect(dasara.deviation).toBeGreaterThan(0.5);
  expect(dasara.occurrences).toBe(2);
});

test('a small wobble on thin data stays below the Poisson noise floor', () => {
  // ~1 FIR/day: a 9-day window expects ~9 cases, so even a 30% swing is noise.
  const spike = new Map();
  for (let i = -4; i <= 4; i += 1) spike.set(utc(2024, 10, 12) + i * DAY, 1.3);
  const cases = build({ from: utc(2024, 1, 1), to: utc(2024, 12, 31), perDay: 1, spikeDays: spike });
  const dasara = find(eventWindows(cases), 'Dasara');
  expect(dasara.verdict).toBe('noise');
});

test('a window that runs past the edge of the data is skipped, not half-counted', () => {
  // Data stops 5 October 2024; the Dasara window (8-16 Oct) is incomplete.
  const cases = build({ from: utc(2024, 1, 1), to: utc(2024, 10, 5), perDay: 20 });
  expect(find(eventWindows(cases), 'Dasara')).toBeUndefined();
  // Ganesh Chaturthi (7 Sep, +/-3) closed before the cut-off and survives.
  expect(find(eventWindows(cases), 'Ganesh Chaturthi')).toBeDefined();
});

test('no data produces no rows rather than a division by zero', () => {
  expect(eventWindows([])).toEqual([]);
  expect(eventWindows([{ ts: NaN }])).toEqual([]);
});

test('every calendar year carries the same named events, so pooling is like-for-like', () => {
  const years = Object.keys(EVENT_CALENDAR);
  const names = years.map((y) => EVENT_CALENDAR[y].map((e) => e.name).sort().join('|'));
  expect(new Set(names).size).toBe(1);
  // And no year is missing from the range the dataset actually covers.
  expect(years).toEqual(expect.arrayContaining(['2023', '2024', '2025', '2026']));
});
