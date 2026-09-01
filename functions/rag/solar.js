'use strict';

/**
 * Sunrise and sunset, computed rather than fetched.
 *
 * WHY THIS IS NOT AN API CALL
 *
 * Several free services return sunrise and sunset for a coordinate, and every
 * one of them would be worse here. This runs inside a serverless function that
 * already answers on a request budget, over records going back to 2023 — the
 * Action Queue re-derives obligations for every open case on every load, so an
 * HTTP call per arrest would be thousands of calls, a key to rotate, a rate
 * limit to respect, and a dependency that turns a legal check into a network
 * failure. The underlying quantity is closed-form astronomy that has not
 * changed since Meeus published it. So it is arithmetic, and it works offline,
 * retroactively, and for free.
 *
 * WHAT IT IS FOR
 *
 * BNSS 43(5) (CrPC 46(4)): a woman may not be arrested after sunset and before
 * sunrise except in exceptional circumstances, and then only with the prior
 * written permission of the jurisdictional magistrate. Answering "was this
 * arrest at night?" needs the actual sunset at that place on that date — not
 * a fixed 18:00, which would be wrong by up to forty minutes across the year
 * and would put arrests on the wrong side of a line that has legal
 * consequences.
 *
 * ACCURACY, AND WHY THE MARGIN MATTERS MORE THAN THE ALGORITHM
 *
 * The NOAA/Meeus approximation used here is good to well under a minute for
 * Indian latitudes — far tighter than the data it is applied to, where an
 * arrest time is recorded to the minute at best and often rounded. So the
 * uncertainty that matters is not astronomical, and `nightArrest` below
 * reports how close to the line an event fell rather than pretending a
 * clean boundary exists.
 */

const RAD = Math.PI / 180;
const J1970 = 2440588;
const J2000 = 2451545;
const DAY_MS = 86_400_000;

// India observes a single offset with no daylight saving, so IST is a constant
// rather than a timezone database lookup. Stated here because a future
// deployment outside India would need to revisit it.
const IST_OFFSET_MIN = 330;
const IST_MS = IST_OFFSET_MIN * 60_000;

// Standard refraction-corrected solar altitude for sunrise/sunset: the sun's
// upper limb touching the horizon, with atmospheric bending allowed for.
const ZENITH = -0.833;

const toJulian = (ms) => ms / DAY_MS - 0.5 + J1970;
const fromJulian = (j) => (j + 0.5 - J1970) * DAY_MS;

/** The civil date in IST that a timestamp falls on, as {y, m, d}. */
function istDate(ms) {
  const d = new Date(ms + IST_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** Midday IST on a given civil date, as a UTC timestamp. */
function istNoon({ y, m, d }) {
  return Date.UTC(y, m - 1, d, 12, 0, 0) - IST_MS;
}

/**
 * Sunrise and sunset for the IST civil date containing `at`.
 *
 * Returns null for either event when the sun does not cross the horizon that
 * day — impossible in India, but a silent NaN propagating into a legal finding
 * is not a failure mode worth leaving open.
 */
function sunTimes(at, latitude, longitude) {
  // null, undefined and '' must be REFUSED, not coerced. Number(null) is 0,
  // which is perfectly finite, so a record with no coordinate would otherwise
  // be computed at 0°N 0°E — the Gulf of Guinea, five and a half hours of
  // sunset away from Karnataka. That is not a rounding error, it is a
  // confidently wrong legal finding about a named officer, and it is the same
  // trap that put a redacted case in the Atlantic.
  const bad = (v) => v === null || v === undefined || v === '' || typeof v === 'boolean';
  if (bad(latitude) || bad(longitude) || bad(at)) return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(Number(at))) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  // Anchor on local noon so the returned pair brackets the civil date, rather
  // than on the instant supplied — an arrest at 00:30 belongs to that date's
  // night, not to the previous day's calculation.
  const noon = istNoon(istDate(at));

  const n = Math.round(toJulian(noon) - J2000 + 0.0008);
  const jStar = n + 0.0008 - lon / 360;               // mean solar time
  const M = (357.5291 + 0.98560028 * jStar) % 360;    // solar mean anomaly
  const C = 1.9148 * Math.sin(M * RAD)                // equation of the centre
    + 0.0200 * Math.sin(2 * M * RAD)
    + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;      // ecliptic longitude
  const jTransit = J2000 + jStar                      // solar noon
    + 0.0053 * Math.sin(M * RAD)
    - 0.0069 * Math.sin(2 * lambda * RAD);
  const decl = Math.asin(Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD));

  const cosOmega = (Math.sin(ZENITH * RAD) - Math.sin(lat * RAD) * Math.sin(decl))
    / (Math.cos(lat * RAD) * Math.cos(decl));
  // |cos| > 1 is midnight sun or polar night: the event does not occur.
  if (cosOmega > 1 || cosOmega < -1) {
    return { sunrise: null, sunset: null, solarNoon: fromJulian(jTransit), polar: true };
  }
  const omega = Math.acos(cosOmega) / RAD;

  return {
    sunrise: fromJulian(jTransit - omega / 360),
    sunset: fromJulian(jTransit + omega / 360),
    solarNoon: fromJulian(jTransit),
    polar: false,
  };
}

/** HH:MM in IST — the only form an officer reads these in. */
function istClock(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + IST_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Was this instant after sunset or before sunrise at this place?
 *
 * "Night" here is the statute's meaning — between sunset and the following
 * sunrise — not a civil-twilight or clock-hour definition.
 *
 * `minutesPastSunset` and `minutesToSunrise` are returned so a caller can say
 * how far past the line an event fell. Twelve minutes after sunset and four
 * hours after sunset are the same fact in law and very different facts to an
 * officer explaining themselves, and a finding that cannot tell them apart
 * invites the reader to dismiss both.
 */
function nightArrest(at, latitude, longitude) {
  // Guarded here as well as in sunTimes, because Number(null) is 0 and 0 is a
  // valid instant — 1 January 1970. Coercing first would hand sunTimes a
  // timestamp it has no reason to reject, and a case with no recorded arrest
  // time would come back as a confident finding about a night in 1970.
  if (at === null || at === undefined || at === '' || typeof at === 'boolean') return null;
  const t = Number(at);
  if (!Number.isFinite(t)) return null;
  const today = sunTimes(t, latitude, longitude);
  if (!today || today.polar || today.sunrise === null || today.sunset === null) return null;

  const beforeSunrise = t < today.sunrise;
  const afterSunset = t > today.sunset;
  const night = beforeSunrise || afterSunset;

  // The sunrise that ends this night: tomorrow's if the sun has already set
  // today, otherwise today's.
  let endsAt = today.sunrise;
  if (afterSunset) {
    const tomorrow = sunTimes(t + DAY_MS, latitude, longitude);
    endsAt = tomorrow && tomorrow.sunrise !== null ? tomorrow.sunrise : null;
  }

  return {
    night,
    at: t,
    sunrise: today.sunrise,
    sunset: today.sunset,
    sunriseClock: istClock(today.sunrise),
    sunsetClock: istClock(today.sunset),
    atClock: istClock(t),
    nightEndsAt: night ? endsAt : null,
    minutesPastSunset: afterSunset ? Math.round((t - today.sunset) / 60_000) : null,
    minutesToSunrise: beforeSunrise ? Math.round((today.sunrise - t) / 60_000) : null,
    // How far into the night, for wording. A margin this small is inside the
    // slack of a hand-written arrest time and should be reported as borderline
    // rather than asserted.
    borderline: night
      && Math.min(
        afterSunset ? (t - today.sunset) / 60_000 : Infinity,
        beforeSunrise ? (today.sunrise - t) / 60_000 : Infinity,
      ) <= 15,
  };
}

// Karnataka's approximate geographic centre, for records with no coordinate.
//
// The state spans about 4° of longitude, so sunset differs by roughly sixteen
// minutes between Bidar and Karwar. A centroid is therefore good to about
// eight minutes — fine for an arrest at 21:40 and useless for one at 18:50,
// which is exactly why anything computed from it is marked `approximate` and
// the caller is expected to say so rather than quietly present it as fact.
const KARNATAKA_CENTRE = { latitude: 15.3173, longitude: 75.7139 };

module.exports = {
  sunTimes, nightArrest, istClock, istDate,
  KARNATAKA_CENTRE, IST_OFFSET_MIN, ZENITH,
};
