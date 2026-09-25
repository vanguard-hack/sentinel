// Karnataka festival and public-event windows, and what crime registration
// does inside them.
//
// The honest version of this analysis is harder than it looks. FIR volume
// already varies by calendar month — the dataset carries a monthly seasonal
// index and per-district profiles, and October runs well above average on
// both. So comparing a Dasara window against the ANNUAL daily mean would
// report a large "festival effect" that is mostly just October. Every
// window here is therefore measured against its own month's ordinary days,
// which holds the month constant and leaves only the window.
//
// The raw annual comparison is reported too, because the gap between the two
// is the interesting part: it says how much of the apparent festival spike
// was the season it sits in.
//
// Dates are the observed Karnataka dates, not computed from a lunar
// calendar. A year that is not listed is skipped rather than guessed.

const R = (name, month, day, windowDays, category) => ({ name, month, day, windowDays, category });

export const EVENT_CALENDAR = {
  2023: [
    R('New Year', 1, 1, 1, 'Public holiday'),
    R('Republic Day', 1, 26, 1, 'National'),
    R('Ugadi', 3, 22, 2, 'State festival'),
    R('Eid al-Fitr', 4, 22, 2, 'Religious'),
    R('Independence Day', 8, 15, 1, 'National'),
    R('Ganesh Chaturthi', 9, 19, 3, 'State festival'),
    R('Dasara', 10, 24, 4, 'State festival'),
    R('Deepavali', 11, 12, 3, 'State festival'),
    R('Christmas', 12, 25, 2, 'Public holiday'),
  ],
  2024: [
    R('New Year', 1, 1, 1, 'Public holiday'),
    R('Republic Day', 1, 26, 1, 'National'),
    R('Ugadi', 4, 9, 2, 'State festival'),
    R('Eid al-Fitr', 4, 11, 2, 'Religious'),
    R('Independence Day', 8, 15, 1, 'National'),
    R('Ganesh Chaturthi', 9, 7, 3, 'State festival'),
    R('Dasara', 10, 12, 4, 'State festival'),
    R('Deepavali', 11, 1, 3, 'State festival'),
    R('Christmas', 12, 25, 2, 'Public holiday'),
  ],
  2025: [
    R('New Year', 1, 1, 1, 'Public holiday'),
    R('Republic Day', 1, 26, 1, 'National'),
    R('Ugadi', 3, 30, 2, 'State festival'),
    R('Eid al-Fitr', 3, 31, 2, 'Religious'),
    R('Independence Day', 8, 15, 1, 'National'),
    R('Ganesh Chaturthi', 8, 27, 3, 'State festival'),
    R('Dasara', 10, 2, 4, 'State festival'),
    R('Deepavali', 10, 20, 3, 'State festival'),
    R('Christmas', 12, 25, 2, 'Public holiday'),
  ],
  2026: [
    R('New Year', 1, 1, 1, 'Public holiday'),
    R('Republic Day', 1, 26, 1, 'National'),
    R('Ugadi', 3, 19, 2, 'State festival'),
    R('Eid al-Fitr', 3, 20, 2, 'Religious'),
    R('Independence Day', 8, 15, 1, 'National'),
    R('Ganesh Chaturthi', 9, 14, 3, 'State festival'),
    R('Dasara', 10, 20, 4, 'State festival'),
    R('Deepavali', 11, 8, 3, 'State festival'),
    R('Christmas', 12, 25, 2, 'Public holiday'),
  ],
};

const DAY = 86400000;
const utcDay = (ts) => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const monthKey = (ts) => {
  const d = new Date(ts);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

// A window is the festival day plus/minus windowDays, so a `windowDays` of 4
// spans nine days. Symmetric because the Karnataka festivals that matter here
// (Dasara, Deepavali, Ganesh Chaturthi) are multi-day observances centred on
// the named day rather than single-day events.
function windowDayKeys(ev, year) {
  const centre = Date.UTC(year, ev.month - 1, ev.day);
  const keys = [];
  for (let i = -ev.windowDays; i <= ev.windowDays; i += 1) keys.push(centre + i * DAY);
  return keys;
}

/**
 * Per-festival registration rates against a month-held-constant baseline.
 *
 * cases: [{ ts }] — every FIR in the report's current range.
 * Returns one row per named festival, pooling all of its occurrences that
 * fall wholly inside the data, plus the totals each figure came from.
 */
export function eventWindows(cases) {
  const perDay = new Map();   // utc day -> FIR count
  const perMonth = new Map(); // month key -> { cases, days:Set }
  let lo = Infinity;
  let hi = -Infinity;

  for (const c of cases) {
    if (!Number.isFinite(c.ts)) continue;
    const k = utcDay(c.ts);
    perDay.set(k, (perDay.get(k) || 0) + 1);
    if (k < lo) lo = k;
    if (k > hi) hi = k;
  }
  if (!perDay.size) return [];

  // Every day in range counts toward its month, including days with no FIR —
  // a quiet day is data, and dropping it would inflate every rate.
  for (let t = lo; t <= hi; t += DAY) {
    const mk = monthKey(t);
    const m = perMonth.get(mk) || { cases: 0, days: 0 };
    m.cases += perDay.get(t) || 0;
    m.days += 1;
    perMonth.set(mk, m);
  }

  const totalCases = [...perDay.values()].reduce((a, b) => a + b, 0);
  const totalDays = Math.round((hi - lo) / DAY) + 1;
  const annualPerDay = totalCases / totalDays;

  const byName = new Map();

  for (const [yearStr, events] of Object.entries(EVENT_CALENDAR)) {
    const year = Number(yearStr);
    for (const ev of events) {
      const keys = windowDayKeys(ev, year);
      // Only whole windows: a half-covered window reads as a dip that is
      // really just the edge of the data.
      if (keys[0] < lo || keys[keys.length - 1] > hi) continue;

      const row = byName.get(ev.name) || {
        name: ev.name, category: ev.category, windowDays: ev.windowDays * 2 + 1,
        occurrences: 0, observed: 0, days: 0, expected: 0, years: [],
      };

      let observed = 0;
      for (const k of keys) observed += perDay.get(k) || 0;

      // Baseline: the ordinary days of whatever month(s) the window touches,
      // the window's own days removed so it cannot be its own comparison.
      const touched = new Set(keys.map(monthKey));
      let baseCases = 0;
      let baseDays = 0;
      for (const mk of touched) {
        const m = perMonth.get(mk);
        if (!m) continue;
        baseCases += m.cases;
        baseDays += m.days;
      }
      for (const k of keys) {
        if (perMonth.has(monthKey(k))) { baseCases -= perDay.get(k) || 0; baseDays -= 1; }
      }
      if (baseDays <= 0) continue;

      row.occurrences += 1;
      row.observed += observed;
      row.days += keys.length;
      row.expected += (baseCases / baseDays) * keys.length;
      row.years.push(year);
      byName.set(ev.name, row);
    }
  }

  return [...byName.values()]
    .filter((r) => r.expected > 0)
    .map((r) => {
      const perDayRate = r.observed / r.days;
      const expectedPerDay = r.expected / r.days;
      const deviation = (r.observed - r.expected) / r.expected;
      // FIR counts are counts, so the noise floor is Poisson: a window of 60
      // expected cases moves +/-8 on nothing at all. Without this a 9-day
      // window on a few hundred cases a year reports a "finding" every time.
      const z = (r.observed - r.expected) / Math.sqrt(r.expected);
      const verdict = Math.abs(z) < 2 ? 'noise' : (z > 0 ? 'above' : 'below');
      return {
        ...r,
        perDayRate,
        expectedPerDay,
        deviation,
        z,
        verdict,
        // How much of the apparent effect is simply the month the festival
        // falls in. Reported so the two readings can be compared.
        vsAnnual: annualPerDay > 0 ? (perDayRate - annualPerDay) / annualPerDay : 0,
      };
    })
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}
