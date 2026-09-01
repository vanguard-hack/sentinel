// Sunrise, sunset, and the night window. Run: node functions/rag/solar.test.js
//
// This module decides whether an arrest happened at night, and that answer
// feeds a legal finding about a named officer. So it is checked against
// published times for real Indian cities rather than against itself, and the
// tolerance is two minutes — tight enough to catch a wrong algorithm, loose
// enough not to fail on the last decimal of a refraction constant.
//
// The reference times are almanac values for the cities and dates named. If a
// future change breaks these, the change is wrong.
const solar = require('./solar');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const IST = 330 * 60_000;
const at = (iso) => Date.parse(`${iso}T06:00:00Z`);
const mins = (clock) => {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
};
const near = (got, want, tol = 2) => Math.abs(mins(got) - mins(want)) <= tol;

// ── Against the almanac ────────────────────────────────────────────────────

const CITIES = {
  Bengaluru: [12.9716, 77.5946],
  Mysuru: [12.2958, 76.6394],
  Kalaburagi: [17.3297, 76.8343],
  Mangaluru: [12.9141, 74.8560],
};

const CASES = [
  ['Bengaluru', '2026-01-15', '06:46', '18:13'],
  ['Bengaluru', '2026-06-15', '05:54', '18:47'],
  ['Bengaluru', '2026-12-15', '06:34', '17:56'],
  ['Mysuru',    '2026-06-15', '05:57', '18:50'],
  ['Kalaburagi','2026-06-15', '05:49', '18:59'],
  ['Mangaluru', '2026-06-15', '06:05', '18:58'],
];

for (const [city, date, rise, set] of CASES) {
  const [lat, lon] = CITIES[city];
  const r = solar.sunTimes(at(date), lat, lon);
  check(`${city} ${date} sunrise ≈ ${rise}`, near(solar.istClock(r.sunrise), rise),
    `got ${solar.istClock(r.sunrise)}`);
  check(`${city} ${date} sunset ≈ ${set}`, near(solar.istClock(r.sunset), set),
    `got ${solar.istClock(r.sunset)}`);
}

// ── Properties the arithmetic must have ────────────────────────────────────

const equinox = solar.sunTimes(at('2026-03-21'), 12.9716, 77.5946);
const dayLen = (equinox.sunset - equinox.sunrise) / 60_000;
check('day and night are near equal at the equinox', dayLen > 720 && dayLen < 730,
  `${dayLen.toFixed(0)} minutes`);
check('  and slightly OVER twelve hours, because refraction lifts the sun',
  dayLen > 720, `${dayLen.toFixed(0)}`);

const june = solar.sunTimes(at('2026-06-21'), 12.9716, 77.5946);
const dec = solar.sunTimes(at('2026-12-21'), 12.9716, 77.5946);
check('the June day is longer than the December day',
  (june.sunset - june.sunrise) > (dec.sunset - dec.sunrise));

// Longitude dominates in India: everywhere shares one clock, so the east sees
// the sun earlier by the clock than the west.
const east = solar.sunTimes(at('2026-06-15'), 15.3, 78.0);
const west = solar.sunTimes(at('2026-06-15'), 15.3, 74.0);
check('the east of the state sees sunset before the west by the same clock',
  east.sunset < west.sunset);
check('  and the gap is about the 16 minutes 4° of longitude implies',
  Math.abs((west.sunset - east.sunset) / 60_000 - 16) < 2,
  `${((west.sunset - east.sunset) / 60_000).toFixed(1)} minutes`);

check('solar noon sits between sunrise and sunset',
  june.solarNoon > june.sunrise && june.solarNoon < june.sunset);

// ── The night window ───────────────────────────────────────────────────────

const day = '2026-06-15';
const istAt = (hhmm) => Date.parse(`${day}T${hhmm}:00.000Z`) - IST;
const [blrLat, blrLon] = CITIES.Bengaluru;
const night = (hhmm) => solar.nightArrest(istAt(hhmm), blrLat, blrLon);

check('an arrest at 21:40 is at night', night('21:40').night === true);
const n2140 = night('21:40');
check('  and reports how long after sunset, consistent with the sunset it reports',
  n2140.minutesPastSunset === Math.round((n2140.at - n2140.sunset) / 60_000)
  && n2140.minutesPastSunset > 170 && n2140.minutesPastSunset < 176,
  String(n2140.minutesPastSunset));
check('an arrest at 04:30 is at night', night('04:30').night === true);
const n0430 = night('04:30');
check('  and reports how long before sunrise, consistent with the sunrise it reports',
  n0430.minutesToSunrise === Math.round((n0430.sunrise - n0430.at) / 60_000)
  && n0430.minutesToSunrise > 80 && n0430.minutesToSunrise < 90,
  String(n0430.minutesToSunrise));
check('an arrest at 14:00 is not at night', night('14:00').night === false);
check('an arrest at 09:00 is not at night', night('09:00').night === false);

// The boundary is the whole point of using real sunset rather than a fixed
// hour: on this date in Bengaluru the sun sets at 18:47, so 18:30 is daylight
// and 19:00 is not — a 18:00 rule would have called both night.
check('18:30 is daylight on a June evening', night('18:30').night === false,
  'a fixed 18:00 cutoff would wrongly flag this');
check('19:00 is night on the same evening', night('19:00').night === true);

check('an arrest minutes past sunset is marked borderline',
  night('18:55').borderline === true,
  'inside the slack of a hand-written arrest time');
check('an arrest hours past sunset is not borderline', night('22:00').borderline === false);
check('a daylight arrest is never borderline', night('12:00').borderline === false);

const late = night('23:30');
check('the night is reported as ending at the NEXT sunrise',
  late.nightEndsAt > late.at && (late.nightEndsAt - late.at) / 3_600_000 < 12,
  String((late.nightEndsAt - late.at) / 3_600_000));

check('the clock strings are IST, not UTC', night('21:40').atClock === '21:40',
  night('21:40').atClock);
check('sunset is reported in IST too', night('21:40').sunsetClock === '18:47',
  night('21:40').sunsetClock);

// An arrest just after midnight belongs to that date's night, not to a
// calculation anchored on the previous day.
const justAfterMidnight = solar.nightArrest(istAt('00:30'), blrLat, blrLon);
check('an arrest at 00:30 is night', justAfterMidnight.night === true);
check('  and is measured against THAT morning\'s sunrise',
  justAfterMidnight.minutesToSunrise > 300 && justAfterMidnight.minutesToSunrise < 340,
  String(justAfterMidnight.minutesToSunrise));

// ── Degenerate input ───────────────────────────────────────────────────────

for (const [name, args] of [
  ['null coordinates', [Date.now(), null, null]],
  ['undefined coordinates', [Date.now(), undefined, undefined]],
  ['empty-string coordinates', [Date.now(), '', '']],
  ['a non-numeric latitude', [Date.now(), 'north', 77]],
  ['an impossible latitude', [Date.now(), 200, 77]],
  ['an impossible longitude', [Date.now(), 12, 400]],
  ['a null timestamp', [null, 12, 77]],
  ['an undefined timestamp', [undefined, 12, 77]],
  ['a non-numeric timestamp', ['yesterday', 12, 77]],
]) {
  check(`${name} returns null rather than NaN`, solar.sunTimes(...args) === null);
  check(`  and nightArrest declines too`, solar.nightArrest(...args) === null);
}

// India never sees a polar day, but a NaN reaching a legal finding is not a
// failure mode worth leaving open.
const polar = solar.sunTimes(Date.parse('2026-06-21T06:00:00Z'), 80, 20);
check('a polar day reports no sunrise or sunset rather than NaN',
  polar.polar === true && polar.sunrise === null && polar.sunset === null);
check('  and nightArrest returns null there',
  solar.nightArrest(Date.parse('2026-06-21T06:00:00Z'), 80, 20) === null);

check('the state centroid is inside Karnataka',
  solar.KARNATAKA_CENTRE.latitude > 11.5 && solar.KARNATAKA_CENTRE.latitude < 18.5
  && solar.KARNATAKA_CENTRE.longitude > 74 && solar.KARNATAKA_CENTRE.longitude < 78.6);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
