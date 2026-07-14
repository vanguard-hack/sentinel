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
//   Status overrides: On Leave / Suspended blank the week; Training runs a
//   training detail Mon–Sat.

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

// Legend shows only the shifts officers actually work.
export const LEGEND = ['morning', 'evening', 'night', 'general', 'off'];

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
  if (officer.status === 'On Leave') return Array(7).fill('leave');
  if (officer.status === 'Suspended') return Array(7).fill('suspended');
  if (officer.status === 'Training') {
    return [...Array(6).fill('training'), 'off'];
  }
  if (officer.rankHierarchy <= 7) {
    return [...Array(6).fill('general'), 'off'];
  }
  const id = Number(officer.id) || 0;
  const weekIdx = Math.floor(Date.parse(weekIso) / WEEK_MS);
  const shift = ROTATION[((id + weekIdx) % 3 + 3) % 3];
  const days = Array(7).fill(shift);
  const rnd = mulberry32((id * 2654435761) ^ (weekIdx * 40503));
  days[Math.floor(rnd() * 7)] = 'off';
  return days;
}
