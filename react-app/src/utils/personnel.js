// Personnel directory data layer.
//
// Core records come from the `Employee` Data Store table (see
// ksp/fir/import/SCHEMA.md) joined client-side against the small master
// tables (Rank, Unit, District) — ZCQL is single-table, so the
// join happens here after a handful of fetchAllRows calls.
//
// Contact details and duty status are not part of the FIR schema (the Data
// Store table can't grow columns without a console migration), so they are
// derived deterministically from EmployeeID: the same officer always gets the
// same email, phone and status across sessions and devices.

import { fetchAllRows } from './datastore';

export const STATUSES = ['Active', 'On Leave', 'Training', 'Suspended'];

// BloodGroupID 1–8 (no master table in the schema; fixed conventional order).
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const GENDERS = { 1: 'Male', 2: 'Female' };

// mulberry32 — tiny seeded PRNG so derived fields are stable per officer.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted(rnd, pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let roll = rnd() * total;
  for (const [value, weight] of pairs) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return pairs[pairs.length - 1][0];
}

function deriveContact(emp) {
  const rnd = mulberry32(Number(emp.EmployeeID) * 2654435761);
  // Full names are unique across the force, so first.last is unique too.
  const email = `${String(emp.FirstName || 'officer')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/ +/g, '.')}@ksp.gov.in`;
  const phone = `+91 9${Math.floor(rnd() * 9000 + 1000)} ${Math.floor(rnd() * 90000 + 10000)}`;
  const status = pickWeighted(rnd, [
    ['Active', 78], ['On Leave', 10], ['Training', 8], ['Suspended', 4],
  ]);
  return { email, phone, status };
}

const yearsSince = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000)));
};

// Human duration since `iso`: whole years, else months, else days.
function durationSince(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) months -= 1;
  if (months >= 12) {
    const y = Math.floor(months / 12);
    return `${y} yr${y === 1 ? '' : 's'}`;
  }
  if (months >= 1) return `${months} mo${months === 1 ? '' : 's'}`;
  const days = Math.max(0, Math.floor((now - d) / 86400000));
  return `${days} day${days === 1 ? '' : 's'}`;
}

// Load and join everything. 744 officers ≈ 3 ZCQL pages, so the whole
// directory is held in memory and filtering/sorting stays instant.
export async function loadPersonnel() {
  const [employees, ranks, units, districts] = await Promise.all([
    fetchAllRows('Employee'),
    fetchAllRows('Rank'),
    fetchAllRows('Unit'),
    fetchAllRows('District'),
  ]);

  const byId = (rows, key) => {
    const m = new Map();
    for (const r of rows) m.set(String(r[key]), r);
    return m;
  };
  const rankById = byId(ranks, 'RankID');
  const unitById = byId(units, 'UnitID');
  const districtById = byId(districts, 'DistrictID');

  const officers = employees.map((e) => {
    const rank = rankById.get(String(e.RankID));
    const unit = unitById.get(String(e.UnitID));
    const district = districtById.get(String(e.DistrictID));
    const { email, phone, status } = deriveContact(e);
    return {
      id: String(e.EmployeeID),
      rowid: e.ROWID,
      name: e.FirstName || '—',
      kgid: e.KGID || '—',
      rank: rank?.RankName || `Rank ${e.RankID}`,
      rankHierarchy: Number(rank?.Hierarchy ?? 99),
      unit: unit?.UnitName || `Unit ${e.UnitID}`,
      district: district?.DistrictName || `District ${e.DistrictID}`,
      districtId: String(e.DistrictID),
      rankId: String(e.RankID),
      gender: GENDERS[Number(e.GenderID)] || '—',
      bloodGroup: BLOOD_GROUPS[Number(e.BloodGroupID) - 1] || '—',
      physicallyChallenged: String(e.PhysicallyChallenged) === 'true',
      dob: e.EmployeeDOB || null,
      age: yearsSince(e.EmployeeDOB),
      appointmentDate: e.AppointmentDate || null,
      service: durationSince(e.AppointmentDate),
      email,
      phone,
      status,
    };
  });

  // Filter options, in a sensible display order.
  const districtOptions = [...new Set(officers.map((o) => o.district))].sort();
  const rankOptions = [...new Map(officers.map((o) => [o.rank, o.rankHierarchy]))]
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);

  return { officers, districtOptions, rankOptions };
}

export const SORTS = {
  seniority: {
    label: 'Rank (senior first)',
    fn: (a, b) => a.rankHierarchy - b.rankHierarchy || a.name.localeCompare(b.name),
  },
  name: { label: 'Name A–Z', fn: (a, b) => a.name.localeCompare(b.name) },
  service: {
    label: 'Longest service',
    fn: (a, b) =>
      (a.appointmentDate ? +new Date(a.appointmentDate) : Infinity) -
      (b.appointmentDate ? +new Date(b.appointmentDate) : Infinity),
  },
  newest: {
    label: 'Newest recruits',
    fn: (a, b) => new Date(b.appointmentDate || 0) - new Date(a.appointmentDate || 0),
  },
};
