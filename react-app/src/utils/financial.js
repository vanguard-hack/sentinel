// Financial-intelligence layer for the AI Analytics → Financial trails view.
//
// IMPORTANT: the FIR schema has NO transaction data. To demonstrate the
// financial-crime workflow, plausible transactions are SYNTHESISED
// deterministically (seeded PRNG) around accused who are named in economic,
// cyber and property FIRs. Everything here is a demo on synthetic data and is
// decision-support only — real deployment needs STR/CTR feeds (FIU-IND),
// bank/UPI records, and legal authorisation.

import { fetchSharedCases, fetchSharedAccused, fetchSnapshotTable } from './datastore';
import { seededRandom, layoutForce, normaliseLayout, components } from './graphLayout';
import { derived, invalidate } from './derived';
import { afterPaint } from './idle';

// Paging lives in datastore.pageQuery, which reports when it stopped short.
// Three modules each had their own copy of this loop with a different
// ceiling, and at 30,000 cases all three silently truncated.

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

// Indian-numbering money format: crore / lakh / thousand, with the exact
// rupee figure kept alongside for large amounts.
export function formatRs(n) {
  const v = Math.round(Number(n) || 0);
  const abs = Math.abs(v);
  if (abs >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `₹${(v / 1e3).toFixed(1)} K`;
  return '₹' + v.toLocaleString('en-IN');
}

export async function fetchFinancialData() {
  const [caseRows, accusedRows, unitRows, districtRows, headRows] = await Promise.all([
    fetchSharedCases(),
    fetchSharedAccused(),
    fetchSnapshotTable('Unit'),
    fetchSnapshotTable('District'),
    fetchSnapshotTable('CrimeHead'),
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


// ── Money-laundering typologies (research-backed AML patterns) ───────────────
// Detected from a synthesised directed transaction graph. Labels/descriptions
// double as the analyst-facing legend.
export const TYPOLOGIES = {
  structuring:     { label: 'Structuring / smurfing', weight: 20, desc: 'Many transfers kept just below the ₹50k reporting threshold' },
  layering:        { label: 'Layering', weight: 18, desc: 'Rapid burst of transfers to obscure the money’s origin' },
  fanIn:           { label: 'Fan-in (mule hub)', weight: 22, desc: 'Funds collected from many accounts into one' },
  fanOut:          { label: 'Fan-out (dispersal)', weight: 20, desc: 'Funds dispersed from one account to many' },
  roundTrip:       { label: 'Round-tripping', weight: 25, desc: 'Funds cycle back to their origin through intermediaries' },
  passThrough:     { label: 'Pass-through', weight: 15, desc: 'Value received and moved on within a short window' },
  highCash:        { label: 'High-value cash', weight: 12, desc: 'Large cash placement (≥ ₹10L)' },
  highRiskChannel: { label: 'High-risk channel', weight: 12, desc: 'Hawala / crypto transfers' },
  shellMule:       { label: 'Shell / mule account', weight: 10, desc: 'Transfers to or from shell / mule accounts' },
};

const CH_NORMAL = ['UPI', 'Bank transfer'];
const RS = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo));


// ── Real branch codes, for synthetic accounts ─────────────────────────────
//
// The accounts in this module are invented; the BRANCHES they sit at are not.
// Each shell or mule account is pinned to a genuine Karnataka IFSC, so
// resolving it through the public IFSC directory (see utils/publicRefs) turns
// "SHELL-4821" into "Karnataka Bank, Vidyaranyapura, Bangalore" and the money
// acquires a geography — which is the question an investigator actually asks
// about layering: where did it go.
//
// Every code below was verified against the live directory rather than
// guessed, and they are spread across districts on purpose: a laundering chain
// that never leaves one branch demonstrates nothing.
//
// Nothing here makes the transactions real. The generator still synthesises
// them, the UI still says so, and the only genuine thing on the screen is which
// branch a code belongs to.
export const BRANCH_POOL = [
  'KARB0000123', // Karnataka Bank, Vidyaranyapura, Bangalore
  'HDFC0000053', // HDFC, Koramangala, Bangalore
  'ICIC0000002', // ICICI, M G Road, Bangalore
  'BARB0BANGAL', // Bank of Baroda, K G Road, Bangalore
  'CNRB0000789', // Canara Bank, Kempegowdanagar, Bangalore
  'SBIN0000813', // SBI, Bangalore
  'KARB0000456', // Karnataka Bank, Kodigehalli, Bangalore Rural
  'SBIN0040650', // SBI, Shirur Park, Hubli-Dharwad
  'SBIN0040200', // SBI, ADB Hassan
  'SBIN0040300', // SBI, Bijapur
  'KARB0000300', // Karnataka Bank, Shimoga
  'SBIN0040150', // SBI, Kundapura
  'CNRB0000456', // Canara Bank, Ponnampet
  'SBIN0040350', // SBI, Honganur, Ramanagara
  'SBIN0040101', // SBI, Koratagere, Tumkur
];

// Synthesise a directed transaction graph whose structure embeds real ML
// typologies, then re-detect those typologies from the graph (so detection is
// principled, not just echoing the generator).
export function buildFinancialTrails({ cases, accused }) {
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const byPerson = new Map();
  accused.forEach((a) => {
    if (!a.person) return;
    const c = caseById.get(a.caseId);
    if (!c || !FIN_HEADS.test(c.head)) return;
    if (!byPerson.has(a.person)) byPerson.set(a.person, { name: a.name || a.person, cases: [] });
    byPerson.get(a.person).cases.push(c);
  });

  const entityLabel = new Map();
  const entityKind = new Map(); // person | shell | mule
  byPerson.forEach((agg, p) => { entityLabel.set(p, agg.name); entityKind.set(p, 'person'); });
  // Which branch each synthetic account sits at. Seeded from the account id, so
  // the same account is always at the same branch across reloads — a mule that
  // moves bank every refresh is not evidence of anything.
  const entityBranch = new Map();
  const acct = (prefix, seed) => {
    const id = `${prefix}-${1000 + (seed % 9000)}`;
    if (!entityLabel.has(id)) {
      entityLabel.set(id, id);
      entityKind.set(id, prefix === 'MULE' ? 'mule' : 'shell');
      entityBranch.set(id, BRANCH_POOL[Math.abs(djb2(id)) % BRANCH_POOL.length]);
    }
    return id;
  };

  const txns = [];
  const add = (from, to, amount, channel, ts, c) => {
    txns.push({ id: 'FT' + txns.length, from, to, amount: Math.round(amount), channel, ts, caseId: c.id, crimeNo: c.crimeNo, head: c.head });
  };

  // Each person gets a seeded "profile" that shapes the transactions they
  // generate — this is what plants detectable typologies.
  const PROFILES = ['structurer', 'layerer', 'collector', 'distributor', 'passthrough', 'ordinary'];
  byPerson.forEach((agg, person) => {
    const rnd = mulberry32(djb2(person));
    const profile = PROFILES[Math.floor(rnd() * PROFILES.length)];
    const c0 = agg.cases[Math.floor(rnd() * agg.cases.length)];
    const base = c0.ts + Math.round((rnd() - 0.5) * 30 * 86400000);

    if (profile === 'structurer') {
      const n = 4 + Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) add(person, acct('SHELL', djb2(person + i)), THRESHOLD - 1 - RS(rnd, 0, 9000), pick(rnd, ['UPI', 'Bank transfer', 'Cash']), base + i * RS(rnd, 1, 4) * 86400000, c0);
    } else if (profile === 'layerer') {
      // rapid chain through mules, occasionally looping back (round-trip)
      const hops = 4 + Math.floor(rnd() * 4);
      let amount = RS(rnd, 800000, 4000000);
      let cur = person;
      const t0 = base;
      for (let i = 0; i < hops; i++) {
        const next = i === hops - 1 && rnd() < 0.5 ? person : acct('MULE', djb2(person + 'h' + i));
        add(cur, next, amount, pick(rnd, [...CH_NORMAL, 'Crypto', 'Hawala']), t0 + i * RS(rnd, 3, 20) * 3600000, c0);
        amount *= 0.9 + rnd() * 0.08;
        cur = next;
      }
    } else if (profile === 'collector') {
      const n = 4 + Math.floor(rnd() * 5); // fan-in
      let total = 0;
      for (let i = 0; i < n; i++) { const amt = RS(rnd, 20000, 120000); total += amt; add(acct('MULE', djb2(person + 'c' + i)), person, amt, pick(rnd, CHANNELS), base + i * RS(rnd, 0, 3) * 86400000, c0); }
      add(person, acct('SHELL', djb2(person + 'out')), total * (0.85 + rnd() * 0.1), pick(rnd, ['Hawala', 'Cash', 'Bank transfer']), base + 6 * 86400000, c0);
    } else if (profile === 'distributor') {
      const inAmt = RS(rnd, 2000000, 8000000); // fan-out
      add(acct('SHELL', djb2(person + 'src')), person, inAmt, pick(rnd, ['Hawala', 'Bank transfer']), base, c0);
      const n = 4 + Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) add(person, acct('MULE', djb2(person + 'd' + i)), inAmt / n * (0.8 + rnd() * 0.3), pick(rnd, CHANNELS), base + (1 + i) * RS(rnd, 0, 2) * 86400000, c0);
    } else if (profile === 'passthrough') {
      const amt = RS(rnd, 500000, 3000000);
      const via = acct('MULE', djb2(person + 'p'));
      add(via, person, amt, pick(rnd, CHANNELS), base, c0);
      add(person, acct('SHELL', djb2(person + 'p2')), amt * (0.96 + rnd() * 0.03), pick(rnd, ['Hawala', 'Crypto', 'Bank transfer']), base + RS(rnd, 2, 40) * 3600000, c0);
    } else {
      const n = 2 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) add(person, acct('SHELL', djb2(person + 'o' + i)), RS(rnd, 5000, 90000), pick(rnd, CHANNELS), base + i * RS(rnd, 2, 15) * 86400000, c0);
    }
  });

  // ── Detection over the generated graph ─────────────────────────────────────
  const outAdj = new Map(); // entity → [{to, ts, id}]
  const outByPerson = new Map();
  const inByPerson = new Map();
  txns.forEach((t) => {
    if (!outAdj.has(t.from)) outAdj.set(t.from, []);
    outAdj.get(t.from).push({ to: t.to, ts: t.ts, id: t.id });
    if (!outByPerson.has(t.from)) outByPerson.set(t.from, []);
    outByPerson.get(t.from).push(t);
    if (!inByPerson.has(t.to)) inByPerson.set(t.to, []);
    inByPerson.get(t.to).push(t);
  });

  // Round-trip: bounded DFS (≤3 hops, increasing time) that returns to origin.
  const hasCycle = (person) => {
    const start = outAdj.get(person) || [];
    const seen = new Set([person]);
    const dfs = (node, ts, depth) => {
      if (depth > 3) return false;
      for (const e of outAdj.get(node) || []) {
        if (e.ts < ts) continue;
        if (e.to === person && depth >= 1) return true;
        if (!seen.has(e.to)) { seen.add(e.to); if (dfs(e.to, e.ts, depth + 1)) return true; seen.delete(e.to); }
      }
      return false;
    };
    return start.some((e) => { seen.add(e.to); const r = e.to === person ? false : dfs(e.to, e.ts, 1); seen.delete(e.to); return r; });
  };

  const alerts = [];
  byPerson.forEach((agg, person) => {
    const out = outByPerson.get(person) || [];
    const inc = inByPerson.get(person) || [];
    const all = [...out, ...inc].sort((a, b) => a.ts - b.ts);
    if (!all.length) return;
    const typ = new Set();

    const structured = out.filter((t) => t.amount >= 40000 && t.amount < THRESHOLD);
    if (structured.length >= 3) typ.add('structuring');
    for (let i = 0; i + 3 < all.length; i++) if (all[i + 3].ts - all[i].ts <= 72 * 3600000) { typ.add('layering'); break; }
    const inDistinct = new Set(inc.map((t) => t.from)).size;
    const outDistinct = new Set(out.map((t) => t.to)).size;
    if (inDistinct >= 4) typ.add('fanIn');
    if (outDistinct >= 4) typ.add('fanOut');
    if (hasCycle(person)) typ.add('roundTrip');
    // pass-through: an incoming closely matched by an outgoing within 48h
    passLoop: for (const ti of inc) for (const to of out) {
      if (to.ts >= ti.ts && to.ts - ti.ts <= 48 * 3600000 && Math.abs(to.amount - ti.amount) / ti.amount < 0.2) { typ.add('passThrough'); break passLoop; }
    }
    if (out.concat(inc).some((t) => t.channel === 'Cash' && t.amount >= 1000000)) typ.add('highCash');
    if (out.concat(inc).some((t) => HIGH_RISK_CH.has(t.channel))) typ.add('highRiskChannel');
    if (out.concat(inc).some((t) => /^(SHELL|MULE)/.test(t.from) || /^(SHELL|MULE)/.test(t.to))) typ.add('shellMule');

    if (!typ.size) return;
    const typologies = [...typ];
    const flaggedTxns = all.filter((t) => t.amount >= 40000 || HIGH_RISK_CH.has(t.channel) || /^(SHELL|MULE)/.test(t.from + t.to) || (t.channel === 'Cash' && t.amount >= 1000000));
    const value = flaggedTxns.reduce((s, t) => s + t.amount, 0);
    let score = typologies.reduce((s, k) => s + TYPOLOGIES[k].weight, 0);
    score = Math.min(100, Math.round(score * 0.75 + Math.min(20, value / 500000)));
    alerts.push({
      person, name: agg.name, typologies, score,
      tier: score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low',
      value, txnCount: all.length, flaggedCount: flaggedTxns.length,
      inDistinct, outDistinct,
      firs: [...new Set(all.map((t) => t.crimeNo))].slice(0, 4),
      narrative: buildNarrative(typologies, inDistinct, outDistinct),
    });
  });
  alerts.sort((a, b) => b.score - a.score);

  const typologyCounts = Object.keys(TYPOLOGIES)
    .map((k) => ({ key: k, ...TYPOLOGIES[k], count: alerts.filter((a) => a.typologies.includes(k)).length }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count);

  // Flagged transactions with per-transaction reasons.
  const flagged = txns.map((t) => {
    const reasons = [];
    if (t.amount >= 40000 && t.amount < THRESHOLD) reasons.push('Sub-threshold');
    if (t.channel === 'Cash' && t.amount >= 1000000) reasons.push('High-value cash');
    if (HIGH_RISK_CH.has(t.channel)) reasons.push(`${t.channel} channel`);
    if (/^(SHELL|MULE)/.test(t.from) || /^(SHELL|MULE)/.test(t.to)) reasons.push('Shell / mule');
    return { ...t, fromLabel: entityLabel.get(t.from) || t.from, toLabel: entityLabel.get(t.to) || t.to, reasons, flagged: reasons.length > 0 };
  }).filter((t) => t.flagged).sort((a, b) => b.amount - a.amount);

  // Money-flow network: top alert entities + their linked accounts.
  //
  // Laid out HERE, once, by the same seeded force layout the crime-network map
  // uses (utils/graphLayout) — see buildMoneyMap. It used to ship a bare node
  // and edge list to a live SVG simulation in the browser, which re-rendered
  // the whole React tree on each of a couple of hundred frames before settling
  // and started again on every drag. Same picture, one paint.
  const top = alerts.slice(0, 14);
  const topSet = new Set(top.map((a) => a.person));
  const entities = new Map();
  const flows = new Map();   // "from|to" -> { from, to, value, count }
  const tierOf = new Map(top.map((a) => [a.person, a.tier]));
  const valueOf = new Map(top.map((a) => [a.person, a.value]));

  const entity = (id) => {
    if (!entities.has(id)) {
      const kind = entityKind.get(id);
      entities.set(id, {
        id,
        label: entityLabel.get(id) || id,
        // An entity of interest is grouped by its risk tier; the accounts the
        // money runs through are grouped by what kind of account they are.
        // That is the distinction an analyst reads the map for.
        kind: topSet.has(id) ? 'Entity' : kind === 'mule' ? 'Mule' : kind === 'shell' ? 'Shell' : 'Counterparty',
        tier: tierOf.get(id) || null,
        // Only accounts have a branch; a person is not held at one.
        ifsc: entityBranch.get(id) || null,
        value: valueOf.get(id) || 0,
        inCount: 0,
        outCount: 0,
      });
    }
    return entities.get(id);
  };
  top.forEach((a) => entity(a.person));
  txns.forEach((t) => {
    if (!topSet.has(t.from) && !topSet.has(t.to)) return;
    const a = entity(t.from);
    const b = entity(t.to);
    a.outCount += 1;
    b.inCount += 1;
    a.value += t.amount;
    b.value += t.amount;
    // One edge per PAIR, not per transfer. Twelve transfers between the same
    // two accounts is one relationship drawn twelve times on top of itself —
    // the weight is what carries "how much", not the number of lines.
    const key = `${t.from}|${t.to}`;
    const f = flows.get(key);
    if (f) { f.value += t.amount; f.count += 1; } else {
      flows.set(key, { from: t.from, to: t.to, value: t.amount, count: 1 });
    }
  });
  const nodes = entities;
  const links = [...flows.values()];

  const summary = {
    txns: txns.length,
    flagged: flagged.length,
    entities: alerts.length,
    typologies: typologyCounts.length,
    value: flagged.reduce((s, t) => s + t.amount, 0),
  };

  // Every branch the money touches, so the caller can resolve them in one pass
  // rather than a request per node.
  const branches = [...new Set([...nodes.values()].map((n) => n.ifsc).filter(Boolean))];

  return {
    summary, alerts, typologyCounts, flagged, branches,
    moneyMap: buildMoneyMap([...nodes.values()], links),
  };
}

function buildNarrative(typ, inD, outD) {
  const parts = [];
  if (typ.includes('fanIn')) parts.push(`collected funds from ${inD} accounts`);
  if (typ.includes('fanOut')) parts.push(`dispersed funds to ${outD} accounts`);
  if (typ.includes('structuring')) parts.push('made repeated sub-₹50k transfers');
  if (typ.includes('layering')) parts.push('moved money in rapid bursts');
  if (typ.includes('roundTrip')) parts.push('cycled funds back to origin');
  if (typ.includes('passThrough')) parts.push('passed value straight through');
  if (typ.includes('highRiskChannel')) parts.push('used hawala / crypto channels');
  if (typ.includes('highCash')) parts.push('placed high-value cash');
  if (typ.includes('shellMule')) parts.push('routed through shell / mule accounts');
  const s = parts.length ? parts.join('; ') : 'flagged transactions';
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

/* ── The money map ───────────────────────────────────────────────────────────
 *
 * The same treatment as the crime-network map: one seeded force layout run
 * once here, a node sized by the value that passes through it, and an edge per
 * counterparty PAIR rather than per transfer.
 *
 * Sizing by value rather than by degree is the one deliberate difference from
 * the ring map. Degree answers "who talks to the most accounts", which on a
 * laundering graph is a property of the typology that generated it; value
 * answers "where is the money", which is the question the tab exists for.
 * Both are square-rooted so one very large chain does not flatten the rest.
 */
export function buildMoneyMap(entityList, flows) {
  const index = new Map(entityList.map((e, i) => [e.id, i]));
  const maxValue = Math.max(1, ...entityList.map((e) => e.value || 0));
  const nodes = entityList.map((e) => ({
    ...e,
    // 9..30px, the same readable band the ring map lands in.
    r: 9 + Math.sqrt((e.value || 0) / maxValue) * 21,
    x: 0,
    y: 0,
  }));
  const links = flows
    .map((f) => ({ s: index.get(f.from), t: index.get(f.to), value: f.value, count: f.count }))
    .filter((l) => l.s != null && l.t != null && l.s !== l.t);

  layoutForce(nodes, links, seededRandom(0x9C71));
  const { clusters } = components(nodes, links);
  normaliseLayout(nodes);

  return {
    nodes,
    links,
    clusters,
    entities: nodes.filter((n) => n.kind === 'Entity').length,
    accounts: nodes.filter((n) => n.kind === 'Mule' || n.kind === 'Shell').length,
  };
}


/* The whole Financial Trails model, built once per session.
 *
 * The transaction ledger is synthesised from a seeded PRNG and every detector
 * downstream of it is pure, so rebuilding it produces a byte-identical result —
 * which makes a quarter-second of work on every visit to the tab pure waste.
 */
export const FINANCIAL_KEY = 'financialTrails';

export function getFinancialTrails() {
  return derived(FINANCIAL_KEY, async () => {
    await afterPaint();          // spinner first, then the build
    return buildFinancialTrails(await fetchFinancialData());
  });
}

export function refreshFinancialTrails() { invalidate(FINANCIAL_KEY); }
