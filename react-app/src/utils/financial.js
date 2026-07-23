// Financial-intelligence layer for the AI Analytics → Financial trails view.
//
// IMPORTANT: the FIR schema has NO transaction data. To demonstrate the
// financial-crime workflow, plausible transactions are SYNTHESISED
// deterministically (seeded PRNG) around accused who are named in economic,
// cyber and property FIRs. Everything here is a demo on synthetic data and is
// decision-support only — real deployment needs STR/CTR feeds (FIU-IND),
// bank/UPI records, and legal authorisation.

import { runQuery } from './datastore';

const PAGE = 300;
async function fetchAll(sql, table) {
  const out = [];
  for (let off = 0; off < 20000; off += PAGE) {
    const rows = await runQuery(`${sql} LIMIT ${off}, ${PAGE}`, table);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const djb2 = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
};
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

const CHANNELS = ['UPI', 'Bank transfer', 'Cash', 'Hawala', 'Crypto'];
const HIGH_RISK_CH = new Set(['Hawala', 'Crypto']);
const FIN_HEADS = /econom|cyber|propert|fraud|cheat|forger|counterfeit/i;
const THRESHOLD = 50000; // structuring is transactions kept just below this

export const formatRs = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

export async function fetchFinancialData() {
  const [caseRows, accusedRows, unitRows, districtRows, headRows] = await Promise.all([
    fetchAll('SELECT CaseMasterID, CrimeNo, CrimeRegisteredDate, PoliceStationID, CrimeMajorHeadID FROM CaseMaster', 'CaseMaster'),
    fetchAll('SELECT CaseMasterID, PersonID, AccusedName FROM Accused', 'Accused'),
    fetchAll('SELECT UnitID, DistrictID FROM Unit', 'Unit'),
    fetchAll('SELECT DistrictID, DistrictName FROM District', 'District'),
    fetchAll('SELECT CrimeHeadID, CrimeGroupName FROM CrimeHead', 'CrimeHead'),
  ]);
  const unitDistrict = new Map(unitRows.map((u) => [String(u.UnitID), String(u.DistrictID)]));
  const districtName = new Map(districtRows.map((d) => [String(d.DistrictID), d.DistrictName]));
  const headName = new Map(headRows.map((h) => [String(h.CrimeHeadID), h.CrimeGroupName]));

  const cases = caseRows
    .map((c) => ({
      id: String(c.CaseMasterID),
      crimeNo: c.CrimeNo || String(c.CaseMasterID),
      ts: Date.parse(String(c.CrimeRegisteredDate || '').slice(0, 10)),
      head: headName.get(String(c.CrimeMajorHeadID)) || 'Other',
      district: districtName.get(unitDistrict.get(String(c.PoliceStationID))) || 'Unknown',
    }))
    .filter((c) => Number.isFinite(c.ts));

  const accused = accusedRows.map((a) => ({
    caseId: String(a.CaseMasterID),
    person: String(a.PersonID || ''),
    name: a.AccusedName || '',
  }));

  return { cases, accused };
}

// Synthesise transactions per financially-relevant accused, then run the
// laundering-signal detectors over them.
export function buildFinancialTrails({ cases, accused }) {
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const byPerson = new Map(); // person → { name, cases: [] }
  const caseCrew = new Map(); // caseId → Set(person)

  accused.forEach((a) => {
    if (!a.person) return;
    const c = caseById.get(a.caseId);
    if (!c || !FIN_HEADS.test(c.head)) return; // only economic/cyber/property etc.
    if (!byPerson.has(a.person)) byPerson.set(a.person, { name: a.name || a.person, cases: [] });
    byPerson.get(a.person).cases.push(c);
    if (!caseCrew.has(a.caseId)) caseCrew.set(a.caseId, new Set());
    caseCrew.get(a.caseId).add(a.person);
  });

  const txns = [];
  byPerson.forEach((agg, person) => {
    const rnd = mulberry32(djb2(person));
    const n = 3 + Math.floor(rnd() * 8);
    for (let i = 0; i < n; i++) {
      const c = agg.cases[Math.floor(rnd() * agg.cases.length)];
      const ts = c.ts + Math.round((rnd() - 0.5) * 40 * 86400000);
      const roll = rnd();
      let amount, channel, structured = false;
      if (roll < 0.26) { // structured: kept just under the reporting threshold
        amount = THRESHOLD - 1 - Math.floor(rnd() * 9500);
        channel = pick(rnd, ['UPI', 'Bank transfer', 'Cash']);
        structured = true;
      } else if (roll < 0.42) { // large movement
        amount = 1000000 + Math.floor(rnd() * 5000000);
        channel = pick(rnd, ['Cash', 'Hawala', 'Bank transfer']);
      } else { // ordinary
        amount = 3000 + Math.floor(rnd() * 70000);
        channel = pick(rnd, CHANNELS);
      }
      // Counterparty: a co-accused (money moving within a ring) or a synthetic
      // shell / mule account.
      const crew = [...(caseCrew.get(c.id) || [])].filter((p) => p !== person);
      let counterId, counterLabel;
      if (crew.length && rnd() < 0.45) {
        counterId = crew[Math.floor(rnd() * crew.length)];
        counterLabel = byPerson.get(counterId)?.name || counterId;
      } else {
        counterId = 'SHELL-' + (1000 + (djb2(person + i) % 9000));
        counterLabel = counterId;
      }
      txns.push({
        id: 'FT' + txns.length, person, name: agg.name, ts,
        dateStr: new Date(ts).toISOString().slice(0, 10),
        amount, channel, structured, counterId, counterLabel,
        caseId: c.id, crimeNo: c.crimeNo, head: c.head,
      });
    }
  });

  // Rapid layering: ≥4 transfers by one person within any 72h window.
  const layering = new Set();
  byPerson.forEach((_, person) => {
    const t = txns.filter((x) => x.person === person).map((x) => x.ts).sort((a, b) => a - b);
    for (let i = 0; i + 3 < t.length; i++) {
      if (t[i + 3] - t[i] <= 3 * 86400000) { layering.add(person); break; }
    }
  });

  txns.forEach((t) => {
    const reasons = [];
    if (t.structured) reasons.push('Structuring');
    if (t.channel === 'Cash' && t.amount >= 1000000) reasons.push('High-value cash');
    if (HIGH_RISK_CH.has(t.channel)) reasons.push(`${t.channel} channel`);
    if (layering.has(t.person)) reasons.push('Rapid layering');
    if (String(t.counterId).startsWith('SHELL')) reasons.push('Shell / mule account');
    t.reasons = reasons;
    t.flagged = reasons.length > 0;
  });

  const flagged = txns.filter((t) => t.flagged);

  const persons = [...byPerson.entries()]
    .map(([person, agg]) => {
      const pt = txns.filter((t) => t.person === person);
      const pf = pt.filter((t) => t.flagged);
      const value = pf.reduce((s, t) => s + t.amount, 0);
      const score = Math.min(100,
        pf.length * 10
        + (layering.has(person) ? 20 : 0)
        + (pf.some((t) => HIGH_RISK_CH.has(t.channel)) ? 15 : 0)
        + Math.min(20, Math.floor(value / 500000)));
      return {
        person, name: agg.name, txns: pt.length, flagged: pf.length, value, score,
        cases: agg.cases.length,
        channels: [...new Set(pt.map((t) => t.channel))],
        tier: score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low',
      };
    })
    .filter((p) => p.flagged > 0)
    .sort((a, b) => b.score - a.score);

  // Money-trail network: top persons of interest, their counterparties and the
  // flagged transfers between them.
  const top = persons.slice(0, 12);
  const topSet = new Set(top.map((p) => p.person));
  const nodes = new Map();
  const links = [];
  top.forEach((p) => nodes.set(p.person, { id: p.person, label: p.name, group: p.tier }));
  flagged.forEach((t) => {
    if (!topSet.has(t.person)) return;
    if (!nodes.has(t.counterId)) {
      nodes.set(t.counterId, {
        id: t.counterId, label: t.counterLabel,
        group: String(t.counterId).startsWith('SHELL') ? 'Shell' : 'Person',
      });
    }
    links.push({ source: t.person, target: t.counterId });
  });

  const summary = {
    txns: txns.length,
    flagged: flagged.length,
    persons: persons.length,
    highRisk: txns.filter((t) => HIGH_RISK_CH.has(t.channel) || (t.channel === 'Cash' && t.amount >= 1000000)).length,
    value: flagged.reduce((s, t) => s + t.amount, 0),
  };

  return {
    summary,
    persons,
    flagged: flagged.sort((a, b) => b.amount - a.amount),
    netSpec: { nodes: [...nodes.values()], links },
  };
}
