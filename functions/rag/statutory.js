'use strict';

/**
 * Statutory obligations — what breaks, and when.
 *
 * THE DIFFERENCE THIS MAKES
 *
 * Sentinel already tells an officer what is missing from a case file. That is a
 * checklist, and a checklist loses. An officer carrying fifteen live cases has
 * fifteen permanently incomplete checklists; nothing in a list of empty boxes
 * says which box matters this morning, so within a week the panel is furniture.
 *
 * The missing half is the consequence. "No witness statements on file" is a
 * fact about a record. "No chargesheet, accused in custody 47 days, default
 * bail arises at day 60" is a fact about what the law will do on a date. The
 * second sorts itself to the top of the list without anyone deciding it should,
 * because it carries a clock.
 *
 * THREE KINDS OF CLOCK, AND ONLY ONE OF THEM IS LEGAL
 *
 *   Statutory — fixed by law, counted from a date already in the record. The
 *     custody clock is the one that matters: past it, the accused is entitled
 *     to release irrespective of the strength of the case.
 *
 *   Physical — nothing to do with law. CCTV overwrites, call records age out
 *     of retention. Miss the window and the evidence is simply gone.
 *
 *   Admissibility — no deadline at all, but the evidence is worthless without
 *     the paperwork. This is the one officers most often lose cases to,
 *     because nothing about it looks urgent: the footage exists, everyone has
 *     watched it, and it cannot be put before the court.
 *
 * WHAT THIS IS NOT
 *
 * It reads the record, not the world. If a seizure memo exists on paper in a
 * folder and was never entered, this says it is missing — and it will be
 * telling an officer off for something they actually did. That is tolerable
 * only if the wording stays honest about which it is claiming: every finding
 * below is phrased as a statement about the FILE ("no seizure reference is
 * recorded against this exhibit"), never about the officer ("you failed to
 * record a seizure"). Obligations can also be acknowledged as done-offline,
 * because an alert that cannot be dismissed is an alert that gets ignored
 * wholesale.
 *
 * ON THE SECTION NUMBERS
 *
 * legal_kb.json carries substantive law only — IPC, NDPS, POCSO and so on. The
 * obligations here are procedural (BNSS) and evidentiary (BSA), which the
 * reference does not cover, so the small table below is this module's own and
 * follows the same convention as the rest of the legal layer: verified: false,
 * with the caveat carried through to the officer.
 *
 * The citation is deliberately the SUPPORTING detail rather than the claim. An
 * obligation states the finding and the consequence in plain words and both
 * stand on their own; the section is offered so an officer can check the
 * authority, not so they have to trust it. A wrong number should cost a
 * citation, never the alert.
 *
 * NOTE for whoever verifies these against the bare acts: Sentinel's own report
 * templates already carry the correct convention — "Witnesses examined u/s 180
 * BNSS (161 CrPC)" — pairing the new section with the familiar old one. But
 * utils/investigation.js's nextStepSuggestions() currently says "(Section 161
 * BNSS)", which conflates the two numbering systems: 161 is the CrPC section,
 * 180 is its BNSS successor. This module uses the paired form throughout.
 */

// Procedural and evidentiary authorities. `verified: false` throughout, per the
// convention in legal.js — this is an operational reference for a prototype,
// not a citation checked against the bare act.
const AUTHORITIES = {
  custody: {
    act: 'BNSS', section: '187(3)', legacy: 'CrPC 167(2)',
    title: 'Detention beyond twenty-four hours where investigation is incomplete',
    verified: false,
  },
  policeReport: {
    act: 'BNSS', section: '193', legacy: 'CrPC 173',
    title: 'Report of police officer on completion of investigation',
    verified: false,
  },
  statements: {
    act: 'BNSS', section: '180', legacy: 'CrPC 161',
    title: 'Examination of witnesses by police',
    verified: false,
  },
  caseDiary: {
    act: 'BNSS', section: '192', legacy: 'CrPC 172',
    title: 'Diary of proceedings in investigation',
    verified: false,
  },
  electronicEvidence: {
    act: 'BSA', section: '63', legacy: 'IEA 65B',
    title: 'Admissibility of electronic records',
    verified: false,
  },
  seizure: {
    act: 'BNSS', section: '106', legacy: 'CrPC 102',
    title: 'Power to seize property',
    verified: false,
  },
};

// The custody window. Under BNSS s.187(3) the period before an accused becomes
// entitled to release on bail depends on the gravity of the offence charged:
// the longer window for offences punishable with death, imprisonment for life,
// or imprisonment of ten years or more; the shorter one otherwise.
const CUSTODY_LONG_DAYS = 90;
const CUSTODY_SHORT_DAYS = 60;

// Roughly how long a small commercial DVR holds footage before it laps. Not a
// legal figure and presented as an estimate, but the reason the certificate
// cannot wait: the recording it certifies stops existing.
const DVR_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;
const daysBetween = (from, to = Date.now()) => Math.floor((to - from) / DAY_MS);

/** Parse a date that may be an ISO string, a date-only string, or a ms number. */
function toTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * Does any section charged on this case carry the graver punishment class?
 *
 * Derived from legal_kb.json's own `punishment` text rather than a hardcoded
 * list of section numbers, so the classification follows the reference: change
 * an entry there and the window here changes with it.
 */
function gravePunishment(text) {
  const t = String(text || '').toLowerCase();
  if (/death/.test(t)) return true;
  if (/imprisonment for life|life imprisonment/.test(t)) return true;
  // "ten years", "10 years", "fourteen years" — anything at or above ten.
  const words = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20 };
  for (const [w, n] of Object.entries(words)) {
    if (n >= 10 && new RegExp(`\\b${w}\\s+years?`).test(t)) return true;
  }
  const m = t.match(/(\d+)\s*years?/g) || [];
  return m.some((s) => parseInt(s, 10) >= 10);
}

/** Section tokens out of a free-text sections field: "379, 457 IPC" → ['379','457']. */
function sectionTokens(sections) {
  return String(sections || '')
    .split(/[,;/]|\band\b/i)
    .map((s) => (s.match(/\d+[A-Za-z]*(?:\(\d+\))?/) || [])[0])
    .filter(Boolean);
}

/**
 * The custody window for this case, and the basis for it.
 *
 * When no charged section resolves against the reference we fall back to the
 * SHORTER window and say so. The asymmetry is deliberate: an officer warned at
 * 60 days on a case that actually allows 90 acts a month early, which costs
 * them some effort. The reverse error lets a deadline pass unseen and an
 * accused walk. Where the two failures are that unequal, the safe default is
 * not the accurate one.
 */
function custodyWindow(sections, kb) {
  const tokens = sectionTokens(sections);
  // legal_kb.json is { _meta, sections: [...] }, but accept a bare array too so
  // a caller can pass a filtered subset without having to re-wrap it.
  const entries = Array.isArray(kb) ? kb : ((kb && kb.sections) || []);
  const matched = [];
  for (const tok of tokens) {
    const e = entries.find((x) => String(x.section) === tok || String(x.bns_equivalent) === tok);
    if (e) matched.push(e);
  }
  const grave = matched.find((e) => gravePunishment(e.punishment));
  if (grave) {
    return {
      days: CUSTODY_LONG_DAYS,
      basis: `${grave.act} ${grave.section} (${grave.title}) is punishable with ${grave.punishment.toLowerCase()}`,
      certain: true,
    };
  }
  if (matched.length) {
    return {
      days: CUSTODY_SHORT_DAYS,
      basis: `no section charged carries death, life, or ten years or more`,
      certain: true,
    };
  }
  return {
    days: CUSTODY_SHORT_DAYS,
    basis: tokens.length
      ? `the sections on this case (${tokens.join(', ')}) are not in the legal reference — the shorter window is assumed`
      : 'no sections are recorded on this case — the shorter window is assumed',
    certain: false,
  };
}

/** Severity from how much time is left. Overdue outranks everything. */
function clockSeverity(daysRemaining) {
  if (daysRemaining === null || daysRemaining === undefined) return 'medium';
  if (daysRemaining <= 0) return 'overdue';
  if (daysRemaining <= 15) return 'critical';
  if (daysRemaining <= 30) return 'high';
  return 'medium';
}

const RANK = { overdue: 0, critical: 1, high: 2, medium: 3, low: 4 };

/**
 * Every obligation open on one case.
 *
 * `rec` is a full investigation record. `kb` is legal_kb.json. Pure: no I/O, no
 * clock beyond `now`, so the whole engine is testable and a test can pin a date.
 */
function obligationsFor(rec, kb, now = Date.now()) {
  if (!rec) return [];
  const out = [];
  const status = String(rec.status || '');
  const settled = ['Chargesheet Filed', 'Closed'].includes(status);
  const acked = rec.obligationAcks || {};

  const persons = rec.persons || [];
  const evidence = rec.evidence || [];
  const timeline = rec.timeline || [];
  const statements = rec.statements || [];
  const diary = rec.diaryEntries || [];

  const add = (o) => {
    const ack = acked[o.id];
    out.push({
      ...o,
      caseMasterId: rec.caseMasterId,
      crimeNo: rec.crimeNo || rec.caseNo || rec.caseMasterId,
      station: rec.station || '',
      ioName: rec.ioName || '',
      acknowledged: ack ? { by: ack.by || '', at: ack.at || null, note: ack.note || '' } : null,
    });
  };

  // ── 1. The custody clock ────────────────────────────────────────────────
  // The one obligation on this list whose deadline releases a person.
  const arrested = persons.filter(
    (p) => String(p.status) === 'Arrested' && ['Accused', 'Suspect'].includes(String(p.role)),
  );
  if (arrested.length && !settled) {
    // Prefer an explicit Arrest event on the timeline; fall back to when the
    // person was entered, which is the earliest defensible date in the record.
    const arrestEvents = timeline
      .filter((t) => String(t.type) === 'Arrest')
      .map((t) => toTime(t.ts))
      .filter((t) => t !== null);
    const personTimes = arrested.map((p) => toTime(p.ts)).filter((t) => t !== null);
    const arrestedAt = arrestEvents.length
      ? Math.min(...arrestEvents)
      : (personTimes.length ? Math.min(...personTimes) : null);

    if (arrestedAt !== null) {
      const win = custodyWindow(rec.sections, kb);
      const elapsed = daysBetween(arrestedAt, now);
      const remaining = win.days - elapsed;
      const names = arrested.map((p) => p.name).filter(Boolean);
      add({
        id: 'custody-clock',
        severity: clockSeverity(remaining),
        kind: 'statutory',
        title: remaining <= 0
          ? 'Custody period exceeded — accused entitled to release'
          : `Chargesheet due in ${remaining} day${remaining === 1 ? '' : 's'}`,
        finding: `${names.length ? names.join(', ') : 'An accused'} has been in custody ${elapsed} days and no police report has been filed on this case.`,
        consequence: remaining <= 0
          ? `The ${win.days}-day period has passed. The accused is entitled to be released on bail regardless of the strength of the case.`
          : `At day ${win.days} the accused becomes entitled to release on bail, irrespective of the strength of the case.`,
        basis: win.basis,
        certain: win.certain,
        authority: AUTHORITIES.custody,
        clock: {
          kind: 'statutory', elapsedDays: elapsed, remainingDays: remaining,
          windowDays: win.days, startedAt: arrestedAt, dueAt: arrestedAt + win.days * DAY_MS,
        },
        action: 'File the police report, or move for an extension of the custody period.',
        actionAuthority: AUTHORITIES.policeReport,
      });
    }
  }

  // ── 2. Electronic evidence without its certificate ──────────────────────
  // Two clocks at once: the footage laps, and without the certificate what
  // survives is inadmissible anyway.
  for (const e of evidence) {
    if (String(e.type) !== 'Digital') continue;
    const hasCert = /\b(63|65b)\b/i.test(String(e.certificateRef || e.seizureMemoRef || e.description || ''));
    if (hasCert) continue;
    const at = toTime(e.ts);
    const elapsed = at === null ? null : daysBetween(at, now);
    const remaining = elapsed === null ? null : DVR_RETENTION_DAYS - elapsed;
    add({
      id: `electronic-evidence:${e.id || e.description || 'item'}`,
      severity: remaining === null ? 'high' : clockSeverity(remaining),
      kind: 'admissibility',
      title: 'Electronic evidence has no certificate recorded',
      finding: `"${String(e.description || 'A digital exhibit').slice(0, 90)}" is logged as digital evidence with no certificate reference against it.`,
      consequence: 'Without the certificate the record is not admissible — the footage can be watched by everyone and still cannot be put before the court.',
      basis: elapsed === null
        ? 'no date is recorded against this exhibit'
        : `logged ${elapsed} days ago; small commercial recorders typically overwrite at around ${DVR_RETENTION_DAYS} days`,
      certain: false,
      authority: AUTHORITIES.electronicEvidence,
      clock: remaining === null ? null : {
        kind: 'physical', elapsedDays: elapsed, remainingDays: remaining,
        windowDays: DVR_RETENTION_DAYS, startedAt: at, dueAt: at + DVR_RETENTION_DAYS * DAY_MS,
      },
      action: 'Obtain the certificate from the person in control of the device, and issue a preservation notice before the recording laps.',
    });
  }

  // ── 3. Physical exhibits with no seizure reference ─────────────────────
  const unmemoed = evidence.filter(
    (e) => ['Physical', 'Forensic'].includes(String(e.type)) && !String(e.seizureMemoRef || '').trim(),
  );
  if (unmemoed.length && !settled) {
    add({
      id: 'seizure-memo',
      severity: 'high',
      kind: 'admissibility',
      title: `${unmemoed.length} exhibit${unmemoed.length === 1 ? '' : 's'} recorded without a seizure reference`,
      finding: `${unmemoed.map((e) => `"${String(e.description || 'exhibit').slice(0, 40)}"`).slice(0, 3).join(', ')}${unmemoed.length > 3 ? ` and ${unmemoed.length - 3} more` : ''} carry no seizure memo reference in the file.`,
      consequence: 'A seizure that is not documented to procedure is attacked at trial as improper, and the exhibit can be excluded.',
      certain: true,
      authority: AUTHORITIES.seizure,
      clock: null,
      action: 'Record the seizure panchanama reference against each exhibit.',
    });
  }

  // ── 4. Forensic exhibits with no lab report ────────────────────────────
  const pendingFsl = evidence.filter(
    (e) => String(e.type) === 'Forensic' && String(e.fslStatus || '') !== 'Report received',
  );
  if (pendingFsl.length && !settled) {
    const oldest = Math.min(...pendingFsl.map((e) => toTime(e.ts) ?? now));
    add({
      id: 'fsl-pending',
      severity: 'medium',
      kind: 'procedural',
      title: `${pendingFsl.length} forensic exhibit${pendingFsl.length === 1 ? '' : 's'} awaiting a lab report`,
      finding: `Forensic evidence is logged with no report received; the oldest has been outstanding ${daysBetween(oldest, now)} days.`,
      consequence: 'A police report filed without the forensic result rests on weaker proof, and the lab queue is outside the investigating officer’s control — the follow-up has to start early.',
      certain: true,
      authority: null,
      clock: null,
      action: 'Follow up with the laboratory and record the acknowledgement reference.',
    });
  }

  // ── 5. No independent statements ───────────────────────────────────────
  if (!statements.length && !settled) {
    add({
      id: 'no-statements',
      severity: arrested.length ? 'high' : 'medium',
      kind: 'procedural',
      title: 'No witness statements recorded',
      finding: 'No statements have been recorded on this case.',
      consequence: arrested.length
        ? 'With an accused in custody and no independent corroboration, the case rests on the complainant and the accused alone.'
        : 'Without independent corroboration the case rests on the complainant alone.',
      certain: true,
      authority: AUTHORITIES.statements,
      clock: null,
      action: 'Examine the first informant, neighbouring occupants and the initial responders, and record their statements.',
    });
  }

  // ── 6. No case diary entries ───────────────────────────────────────────
  if (!diary.length && !settled) {
    const regAt = toTime(rec.registeredDate);
    const elapsed = regAt === null ? null : daysBetween(regAt, now);
    add({
      id: 'no-diary',
      severity: elapsed !== null && elapsed > 7 ? 'high' : 'medium',
      kind: 'procedural',
      title: 'No case diary entry has been filed',
      finding: elapsed === null
        ? 'This case has no diary entries.'
        : `This case was registered ${elapsed} days ago and has no diary entries.`,
      consequence: 'The diary is the day-by-day record of the investigation and is what a court reads to follow what was done and when. A gap in it is a gap in the case.',
      certain: true,
      authority: AUTHORITIES.caseDiary,
      clock: null,
      action: 'File the first diary entry setting out the steps taken so far.',
    });
  }

  // ── 7. The investigation has gone quiet ────────────────────────────────
  if (!settled) {
    const last = toTime(rec.lastDiaryDate) ?? toTime(rec.registeredDate);
    if (last !== null) {
      const silent = daysBetween(last, now);
      if (silent >= 30) {
        add({
          id: 'diary-silent',
          severity: silent >= 90 ? 'high' : 'medium',
          kind: 'procedural',
          title: `No entry for ${silent} days`,
          finding: `The last diary entry on this case was ${silent} days ago.`,
          consequence: silent >= 90
            ? 'A case silent this long reads at trial as an investigation that stopped, whatever was actually happening.'
            : 'A lengthening gap in the diary is what the defence reads as an investigation that stalled.',
          certain: true,
          authority: AUTHORITIES.caseDiary,
          clock: null,
          action: 'File an entry recording the current position, or record the justification for closing the case.',
        });
      }
    }
  }

  // ── 8. Accused not traced ──────────────────────────────────────────────
  const atLarge = persons.filter(
    (p) => String(p.role) === 'Accused' && ['At large', 'Absconding'].includes(String(p.status)),
  );
  if (atLarge.length && !settled) {
    add({
      id: 'accused-at-large',
      severity: 'medium',
      kind: 'procedural',
      title: `${atLarge.length} accused not yet traced`,
      finding: `${atLarge.map((p) => p.name).filter(Boolean).slice(0, 3).join(', ') || 'An accused'} ${atLarge.length === 1 ? 'is' : 'are'} shown as at large or absconding.`,
      consequence: 'Nothing in the file records what has been done to trace them, which is the first thing asked when the case is reviewed.',
      certain: true,
      authority: null,
      clock: null,
      action: 'Record the search and surveillance steps taken as a timeline entry.',
    });
  }

  return out;
}

/**
 * Rank obligations across cases into one queue.
 *
 * Overdue first, then by severity, then by how little time is left. Within the
 * same urgency a statutory clock outranks a physical one, and a physical one
 * outranks an obligation with no clock at all — because only the first two get
 * worse on their own while nobody is looking.
 */
function rank(obligations) {
  const kindWeight = { statutory: 0, physical: 1, admissibility: 2, procedural: 3 };
  return [...obligations].sort((a, b) => {
    const r = RANK[a.severity] - RANK[b.severity];
    if (r !== 0) return r;
    const ar = a.clock?.remainingDays;
    const br = b.clock?.remainingDays;
    if (Number.isFinite(ar) && Number.isFinite(br) && ar !== br) return ar - br;
    if (Number.isFinite(ar) !== Number.isFinite(br)) return Number.isFinite(ar) ? -1 : 1;
    const k = (kindWeight[a.kind] ?? 9) - (kindWeight[b.kind] ?? 9);
    if (k !== 0) return k;
    return String(a.crimeNo).localeCompare(String(b.crimeNo));
  });
}

/**
 * The queue for a set of cases.
 *
 * Acknowledged obligations are kept and marked, never dropped: a supervisor
 * reviewing the queue needs to see that something was dismissed and by whom,
 * and an officer needs to be able to undo it. They simply rank last.
 */
function buildQueue(records, kb, now = Date.now()) {
  const all = [];
  for (const rec of records || []) {
    try {
      all.push(...obligationsFor(rec, kb, now));
    } catch {
      // One malformed record must not blank the whole queue.
    }
  }
  const open = rank(all.filter((o) => !o.acknowledged));
  const done = all.filter((o) => o.acknowledged);
  return {
    obligations: [...open, ...done],
    counts: {
      total: open.length,
      overdue: open.filter((o) => o.severity === 'overdue').length,
      critical: open.filter((o) => o.severity === 'critical').length,
      high: open.filter((o) => o.severity === 'high').length,
      acknowledged: done.length,
      cases: new Set(open.map((o) => o.caseMasterId)).size,
    },
  };
}

module.exports = {
  AUTHORITIES, CUSTODY_LONG_DAYS, CUSTODY_SHORT_DAYS, DVR_RETENTION_DAYS,
  gravePunishment, sectionTokens, custodyWindow, obligationsFor, rank, buildQueue,
};
