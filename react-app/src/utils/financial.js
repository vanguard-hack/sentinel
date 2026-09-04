// Financial-intelligence layer for the AI Analytics → Financial trails view.
//
// IMPORTANT: the FIR schema has NO transaction data. To demonstrate the
// financial-crime workflow, plausible transactions are SYNTHESISED
// deterministically (seeded PRNG) around accused who are named in economic,
// cyber and property FIRs. Everything here is a demo on synthetic data and is
// decision-support only — real deployment needs STR/CTR feeds (FIU-IND),
// bank/UPI records, and legal authorisation.

import { fetchSharedCases, fetchSharedAccused, fetchSnapshotTable } from './datastore';
import { seededRandom, layoutForce, layoutForceAsync, normaliseLayout, components } from './graphLayout';
import { derived, invalidate } from './derived';
import { afterPaint, breathe } from './idle';

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

  /* ── The account pool ──────────────────────────────────────────────────
   *
   * Laundering infrastructure is SHARED and it is UNEVEN. The same mule
   * receives from several different people; the same shell fronts for more
   * than one racket; and a handful of accounts carry far more traffic than
   * the rest, because setting one up costs effort and whoever has one uses
   * it again.
   *
   * The first version of this drew each account id from 9,000 slots keyed on
   * the person, so two entities almost never touched the same account. The
   * result was a picture of N identical disconnected stars — a perfectly
   * regular shape that told an analyst nothing, because the thing worth
   * seeing on a money graph is precisely where two chains MEET.
   *
   * So the pool is bounded (it scales with the number of entities, not with
   * the number of draws) and the index is drawn with a power law: r^2.2 puts
   * most draws on the low indices, so a few accounts become hubs and the rest
   * trail off. That is the degree distribution these networks actually have.
   * The draw is still a pure function of the seed, so the same dataset always
   * produces the same accounts. */
  /* Sized so an account serves a HANDFUL of people, not forty. The pool grows
     with the number of entities rather than being capped, because a fixed cap
     turns every mule into a hub the moment the dataset is large — which is its
     own kind of unreal, and made the round-trip search explode. */
  const POOL = {
    MULE: Math.max(12, Math.round(byPerson.size * 0.45)),
    SHELL: Math.max(10, Math.round(byPerson.size * 0.32)),
  };
  const draw = (prefix, seed) => {
    const size = POOL[prefix];
    const r = (seed >>> 0) / 4294967296;
    const idx = Math.min(size - 1, Math.floor(size * (r ** 2.2)));
    const id = `${prefix}-${1000 + idx}`;
    if (!entityLabel.has(id)) {
      entityLabel.set(id, id);
      entityKind.set(id, prefix === 'MULE' ? 'mule' : 'shell');
      entityBranch.set(id, BRANCH_POOL[Math.abs(djb2(id)) % BRANCH_POOL.length]);
    }
    return id;
  };

  /* An account that is not one of `taken`.
   *
   * Concentrating draws on a small set of hubs is the point, but it made two
   * consecutive draws land on the same account often enough to matter, and the
   * results were nonsense: a layering chain whose next hop was the account it
   * was already at (a transfer from MULE-1146 to MULE-1146), and a fan-in from
   * "many accounts" that was the same account four times. Neither is a
   * transaction anybody could act on, and the first was silently dropped by the
   * map, which is why the layering chains never appeared on it.
   *
   * The seed is bumped and redrawn — deterministic, and bounded so a pool
   * smaller than the request cannot spin. */
  const acct = (prefix, seed, ...taken) => {
    const avoid = new Set(taken.filter(Boolean));
    let id = draw(prefix, seed);
    for (let n = 1; n <= 12 && avoid.has(id); n += 1) {
      id = draw(prefix, djb2(`${prefix}:${seed}:${n}`));
    }
    return id;
  };

  const txns = [];
  const add = (from, to, amount, channel, ts, c) => {
    if (from === to) return;   // never a real movement of money
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
      const used = [];
      for (let i = 0; i < n; i++) {
        const to = acct('SHELL', djb2(person + i), ...used);
        used.push(to);
        add(person, to, THRESHOLD - 1 - RS(rnd, 0, 9000), pick(rnd, ['UPI', 'Bank transfer', 'Cash']), base + i * RS(rnd, 1, 4) * 86400000, c0);
      }
    } else if (profile === 'layerer') {
      // rapid chain through mules, occasionally looping back (round-trip)
      const hops = 4 + Math.floor(rnd() * 4);
      let amount = RS(rnd, 800000, 4000000);
      let cur = person;
      const t0 = base;
      for (let i = 0; i < hops; i++) {
        const next = i === hops - 1 && rnd() < 0.5
          ? person
          : acct('MULE', djb2(person + 'h' + i), cur);
        add(cur, next, amount, pick(rnd, [...CH_NORMAL, 'Crypto', 'Hawala']), t0 + i * RS(rnd, 3, 20) * 3600000, c0);
        amount *= 0.9 + rnd() * 0.08;
        cur = next;
      }
    } else if (profile === 'collector') {
      const n = 4 + Math.floor(rnd() * 5); // fan-in
      let total = 0;
      const from = [];
      for (let i = 0; i < n; i++) {
        const src = acct('MULE', djb2(person + 'c' + i), ...from);
        from.push(src);
        const amt = RS(rnd, 20000, 120000);
        total += amt;
        add(src, person, amt, pick(rnd, CHANNELS), base + i * RS(rnd, 0, 3) * 86400000, c0);
      }
      add(person, acct('SHELL', djb2(person + 'out')), total * (0.85 + rnd() * 0.1), pick(rnd, ['Hawala', 'Cash', 'Bank transfer']), base + 6 * 86400000, c0);
    } else if (profile === 'distributor') {
      const inAmt = RS(rnd, 2000000, 8000000); // fan-out
      add(acct('SHELL', djb2(person + 'src')), person, inAmt, pick(rnd, ['Hawala', 'Bank transfer']), base, c0);
      const n = 4 + Math.floor(rnd() * 5);
      const out = [];
      for (let i = 0; i < n; i++) {
        const to = acct('MULE', djb2(person + 'd' + i), ...out);
        out.push(to);
        add(person, to, inAmt / n * (0.8 + rnd() * 0.3), pick(rnd, CHANNELS), base + (1 + i) * RS(rnd, 0, 2) * 86400000, c0);
      }
    } else if (profile === 'passthrough') {
      const amt = RS(rnd, 500000, 3000000);
      const via = acct('MULE', djb2(person + 'p'));
      add(via, person, amt, pick(rnd, CHANNELS), base, c0);
      add(person, acct('SHELL', djb2(person + 'p2'), via), amt * (0.96 + rnd() * 0.03), pick(rnd, ['Hawala', 'Crypto', 'Bank transfer']), base + RS(rnd, 2, 40) * 3600000, c0);
    } else {
      const n = 2 + Math.floor(rnd() * 3);
      const seen = [];
      for (let i = 0; i < n; i++) {
        const to = acct('SHELL', djb2(person + 'o' + i), ...seen);
        seen.push(to);
        add(person, to, RS(rnd, 5000, 90000), pick(rnd, CHANNELS), base + i * RS(rnd, 2, 15) * 86400000, c0);
      }
    }
  });

  /* ── Co-accused transfers ──────────────────────────────────────────────
   *
   * People named in the SAME FIR paying each other directly. This is the one
   * link in the ledger that is not invented from a profile: the pairing comes
   * out of the case records, so a person-to-person edge on the map always
   * corresponds to two people who were actually charged together.
   *
   * It matters to the picture as well as to the truth of it. Without it the
   * only path between two entities of interest ran through a shared account,
   * and a network where principals never deal with each other directly is not
   * one an investigator would recognise. Not every pair transacts — a coin is
   * tossed per pair, seeded on the pair itself — because a graph where every
   * co-accused pair moved money would be as unreal as one where none did. */
  const financialCase = new Map();   // caseId -> [person]
  accused.forEach((a) => {
    if (!a.person || !byPerson.has(a.person)) return;
    const list = financialCase.get(a.caseId);
    if (list) { if (!list.includes(a.person)) list.push(a.person); }
    else financialCase.set(a.caseId, [a.person]);
  });
  financialCase.forEach((people, caseId) => {
    if (people.length < 2) return;
    const c = caseById.get(caseId);
    if (!c) return;
    for (let i = 0; i < people.length; i += 1) {
      for (let j = i + 1; j < people.length; j += 1) {
        const pair = people[i] < people[j] ? `${people[i]}|${people[j]}` : `${people[j]}|${people[i]}`;
        const r = mulberry32(djb2(pair));
        if (r() > 0.3) continue;
        // Direction is part of the finding: who paid whom.
        const [from, to] = r() < 0.5 ? [people[i], people[j]] : [people[j], people[i]];
        add(from, to, RS(r, 30000, 900000), pick(r, CHANNELS), c.ts + RS(r, 1, 45) * 86400000, c);
      }
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
  /* Round-trip: does money leave this person and come back within four hops,
   * with each hop no earlier than the last?
   *
   * This was a depth-first walk over simple paths, which re-walked every
   * branch and became unusable the moment accounts started being shared — one
   * account used by several people multiplies the branching at every hop. It
   * is now a breadth-first relaxation keeping the EARLIEST time each account
   * can be reached, so each is expanded once per hop.
   *
   * Same answer, not an approximation of it: an earlier arrival can only allow
   * more onward edges, so the earliest is the one worth keeping. And a
   * time-respecting walk back to the origin always contains a time-respecting
   * simple path back — cutting a loop out of the middle joins an earlier hop
   * to a later one, which is still non-decreasing. */
  const hasCycle = (person) => {
    const start = outAdj.get(person);
    if (!start || !start.length) return false;
    let frontier = new Map();   // node -> earliest ts we can be there
    for (const e of start) {
      if (e.to === person) continue;
      const cur = frontier.get(e.to);
      if (cur === undefined || e.ts < cur) frontier.set(e.to, e.ts);
    }
    for (let hop = 1; hop <= 3 && frontier.size; hop += 1) {
      const next = new Map();
      for (const [node, ts] of frontier) {
        for (const e of outAdj.get(node) || []) {
          if (e.ts < ts) continue;
          if (e.to === person) return true;
          const cur = next.get(e.to);
          if (cur === undefined || e.ts < cur) next.set(e.to, e.ts);
        }
      }
      frontier = next;
    }
    return false;
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

  /* ── The money-flow map ────────────────────────────────────────────────
   *
   * Laid out HERE, once, by the same seeded force layout the crime-network map
   * uses (utils/graphLayout) — see buildMoneyMap. It used to ship a bare node
   * and edge list to a live SVG simulation in the browser, which re-rendered
   * the whole React tree on each of a couple of hundred frames before settling
   * and started again on every drag. Same picture, one paint.
   *
   * TWO HOPS, NOT ONE. This drew only the transfers that touched a top entity
   * directly, which is why it came out as a row of identical stars: a
   * principal in the middle, its own accounts around it, and nothing joining
   * one star to the next. But the first hop is the boring half of a laundering
   * chain. What an investigator is looking for is the SECOND: where the money
   * goes after the mule, and — the actual finding — where two chains run
   * through the same account.
   *
   * Real money graphs are lopsided, so this one is too: a handful of dense
   * knots, some long thin chains, a few pairs that only touch each other, and
   * a scatter of leaves. That shape comes out of the ledger rather than being
   * imposed here — see the account pool above. */
  const HOPS = 2;
  const MAX_NODES = 190;
  const top = alerts.slice(0, 18);
  const topSet = new Set(top.map((a) => a.person));

  // Directed flows over the whole ledger: one entry per counterparty PAIR,
  // because twelve transfers between the same two accounts is one relationship
  // drawn twelve times on top of itself. Weight carries "how much".
  const allFlows = new Map();          // "from|to" -> { from, to, value, count }
  const near = new Map();              // node -> Set(neighbours), undirected
  const touch = (a, b) => {
    const set = near.get(a);
    if (set) set.add(b); else near.set(a, new Set([b]));
  };
  txns.forEach((t) => {
    const key = `${t.from}|${t.to}`;
    const f = allFlows.get(key);
    if (f) { f.value += t.amount; f.count += 1; } else {
      allFlows.set(key, { from: t.from, to: t.to, value: t.amount, count: 1 });
    }
    touch(t.from, t.to);
    touch(t.to, t.from);
  });

  /* Grow outward from the flagged entities, a hop at a time, and stop at the
     node budget rather than mid-hop — a half-expanded ring reads as a
     boundary in the data that is not there. Within a hop the busiest
     neighbours come first, so what gets dropped is the quiet tail. */
  const keep = new Set(topSet);
  let ring = [...topSet];
  for (let hop = 0; hop < HOPS && keep.size < MAX_NODES; hop += 1) {
    const nextRing = [];
    const candidates = new Set();
    ring.forEach((id) => (near.get(id) || []).forEach((n) => { if (!keep.has(n)) candidates.add(n); }));
    [...candidates]
      .sort((a, b) => (near.get(b)?.size || 0) - (near.get(a)?.size || 0))
      .forEach((id) => {
        if (keep.size >= MAX_NODES) return;
        keep.add(id);
        nextRing.push(id);
      });
    ring = nextRing;
  }

  const entities = new Map();
  const tierOf = new Map(alerts.map((a) => [a.person, a.tier]));
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
        value: 0,
        inCount: 0,
        outCount: 0,
      });
    }
    return entities.get(id);
  };
  keep.forEach((id) => entity(id));

  const flows = new Map();
  allFlows.forEach((f, key) => {
    if (!keep.has(f.from) || !keep.has(f.to)) return;
    const a = entity(f.from);
    const b = entity(f.to);
    a.outCount += f.count;
    b.inCount += f.count;
    a.value += f.value;
    b.value += f.value;
    flows.set(key, f);
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
    // The graph, not the drawing. Laying out 190 nodes is half a second of
    // O(n²) work, so it is a step the caller can yield through rather than
    // something that happens inside this function whether there is time for
    // it or not — see getFinancialTrails.
    moneyGraph: { nodes: [...nodes.values()], flows: links },
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
function moneyMapInput(entityList, flows) {
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
  return { nodes, links };
}

function moneyMapOutput(nodes, links) {
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

export function buildMoneyMap(entityList, flows) {
  const { nodes, links } = moneyMapInput(entityList, flows);
  layoutForce(nodes, links, seededRandom(0x9C71));
  return moneyMapOutput(nodes, links);
}

/** The same map, laid out in slices so the page keeps painting. */
export async function buildMoneyMapAsync(entityList, flows) {
  const { nodes, links } = moneyMapInput(entityList, flows);
  await layoutForceAsync(nodes, links, seededRandom(0x9C71));
  return moneyMapOutput(nodes, links);
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
    const model = buildFinancialTrails(await fetchFinancialData());
    await breathe();
    const { nodes, flows } = model.moneyGraph;
    return { ...model, moneyMap: await buildMoneyMapAsync(nodes, flows) };
  });
}

export function refreshFinancialTrails() { invalidate(FINANCIAL_KEY); }
