// Duty roster derivation for the Personnel → Duty Roster view.
//
// Rosters are not part of the FIR schema, so — like email/phone/status in
// personnel.js — they are derived deterministically: the same officer always
// has the same schedule for a given week, on every device and reload.
//
// Rules (mirroring real station practice):
//   Gazetted officers (hierarchy 1–7)  General shift Mon–Sat, Sunday off.
//   Subordinate ranks (8–12)           rotate Morning → Evening → Night, one
//                                      whole shift per week (rotation advances
//                                      weekly), with one seeded off day.
//   Training status runs a training detail Mon–Sat. On Leave overlays at most
//   TWO consecutive leave days on the normal week (leave is capped at 2 days).
//   Suspended officers have no roster (the page hides them).

import { mulberry32 } from './personnel';

export const SHIFT_TYPES = {
  morning:   { label: 'Morning',   time: '06:00 – 14:00' },
  evening:   { label: 'Evening',   time: '14:00 – 22:00' },
  night:     { label: 'Night',     time: '22:00 – 06:00' },
  general:   { label: 'General',   time: '09:00 – 17:00' },
  training:  { label: 'Training',  time: '09:00 – 17:00' },
  off:       { label: 'Off',       time: '' },
  leave:     { label: 'On Leave',  time: '' },
  suspended: { label: 'Suspended', time: '' },
};

// Legend shows only the shift kinds that appear on the grid.
export const LEGEND = ['morning', 'evening', 'night', 'general', 'training', 'leave', 'off'];

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ISO date of the Monday of the week containing `date` (UTC).
export function mondayOf(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// Same, from a 'YYYY-MM-DD' string.
export function mondayOfIso(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export const shiftWeek = (weekIso, deltaWeeks) =>
  new Date(Date.parse(weekIso) + deltaWeeks * WEEK_MS).toISOString().slice(0, 10);

// The 7 days of a week: [{ iso, dow, day, month }].
export function weekDays(weekIso) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.parse(weekIso) + i * DAY_MS);
    return {
      iso: d.toISOString().slice(0, 10),
      dow: DOW[i],
      day: d.getUTCDate(),
      month: MON[d.getUTCMonth()],
    };
  });
}

// "14 Jul – 20 Jul 2026"
export function weekLabel(weekIso) {
  const days = weekDays(weekIso);
  const a = days[0];
  const b = days[6];
  const y = new Date(Date.parse(weekIso) + 6 * DAY_MS).getUTCFullYear();
  return `${a.day} ${a.month} – ${b.day} ${b.month} ${y}`;
}

const ROTATION = ['morning', 'evening', 'night'];

// The officer's 7 shift keys (Mon..Sun) for the given week.
export function weekRoster(officer, weekIso) {
  if (officer.status === 'Suspended') return Array(7).fill('suspended');

  const id = Number(officer.id) || 0;
  const weekIdx = Math.floor(Date.parse(weekIso) / WEEK_MS);

  let days;
  if (officer.status === 'Training') {
    days = [...Array(6).fill('training'), 'off'];
  } else if (officer.rankHierarchy <= 7) {
    days = [...Array(6).fill('general'), 'off'];
  } else {
    const shift = ROTATION[((id + weekIdx) % 3 + 3) % 3];
    days = Array(7).fill(shift);
    const rnd = mulberry32((id * 2654435761) ^ (weekIdx * 40503));
    days[Math.floor(rnd() * 7)] = 'off';
  }

  // Leave is capped at 2 days: overlay two consecutive leave days on the
  // normal week, seeded so the same officer takes the same days everywhere.
  if (officer.status === 'On Leave') {
    const lr = mulberry32((id * 40503) ^ (weekIdx * 2654435761));
    const start = Math.floor(lr() * 6);
    days[start] = 'leave';
    days[start + 1] = 'leave';
  }
  return days;
}
