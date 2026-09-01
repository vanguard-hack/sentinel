// Protected-crime identity and coordinate coarsening.
// Run: node functions/rag/protected.test.js
//
// Two changes to the clearance filter, both of which relax something, so the
// tests lean hardest on what must NOT have moved:
//
//   • Victim identity on offences against women and children is now withheld
//     from everyone — admin included — until a reason is stated. The failure to
//     guard against is a path that releases the name without one.
//   • Coordinates are coarsened rather than deleted below their tier. The
//     failure to guard against is a "coarse" value precise enough to find a
//     house, or a coarse value handed to a caller who should get nothing.
const redaction = require('./redaction');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// Enriched shape (the ZCQL lane) and raw shape (everything else).
const rape = { CrimeNo: '1', CrimeHead: 'Crimes Against Women', CrimeSubHead: 'Rape',
  VictimName: 'S Devi', ComplainantName: 'R Devi', AccusedName: 'B Rao' };
const child = { CrimeNo: '2', CrimeMajorHeadID: 4, VictimName: 'A Minor', AccusedName: 'C Shah' };
const theft = { CrimeNo: '3', CrimeHead: 'Crimes Against Property', CrimeSubHead: 'House Theft',
  VictimName: 'M Iyer', AccusedName: 'D Naik' };

const REASON = { reason: 'Verifying the victim statement before filing the chargesheet.' };
const v = (rows, role, access) => redaction.filterRows(rows, role, access).rows[0];

// ── Which cases are protected ─────────────────────────────────────────────
check('an offence against a woman is protected, by its enriched head',
  redaction.isProtected(rape));
check('an offence against a child is protected, by its raw id',
  redaction.isProtected(child));
check('the sub-head alone is enough',
  redaction.isProtected({ CrimeSubHead: 'Child Sexual Assault' }));
check('an ordinary property offence is not protected', !redaction.isProtected(theft));
check('a row with no crime fields at all is not protected',
  !redaction.isProtected({ CrimeNo: '9' }) && !redaction.isProtected(null));

// ── The reason gate ───────────────────────────────────────────────────────
// The point of the whole change: clearance alone stops being sufficient.
check('an ADMIN does not get victim identity without stating a reason',
  v([rape], 'admin').VictimName === redaction.PROTECTED_MARK);
check('nor an investigator',
  v([rape], 'investigator').VictimName === redaction.PROTECTED_MARK);
check('the complainant is shielded too — naming them can identify the victim',
  v([rape], 'admin').ComplainantName === redaction.PROTECTED_MARK);
check('with a reason stated, a cleared officer gets it',
  v([rape], 'investigator', REASON).VictimName === 'S Devi');
check('a reason does NOT promote an analyst past their clearance',
  v([rape], 'analyst', REASON).VictimName !== 'S Devi');
check('an empty or whitespace reason is not a reason',
  v([rape], 'admin', { reason: '   ' }).VictimName === redaction.PROTECTED_MARK);

check('the accused is not shielded by this rule — naming a suspect is ordinary work',
  v([rape], 'investigator').AccusedName === 'B Rao');
check('an unprotected case is unchanged: no reason needed',
  v([theft], 'investigator').VictimName === 'M Iyer');
check('and the ordinary tiers still bite on it',
  v([theft], 'analyst').VictimName === '[redacted]');

check('the marker says the name is unlockable, not simply gone',
  /state a reason/i.test(redaction.PROTECTED_MARK)
  && redaction.PROTECTED_MARK !== '[redacted]');

// ── What the caller learns, for the audit trail ───────────────────────────
const refused = redaction.filterRows([rape, child], 'admin');
check('a refused reach is reported', refused.protectedAccess.granted === false);
check('with the number of protected rows behind it', refused.protectedAccess.rows === 2);
check('and how many fields were withheld', refused.protectedAccess.fieldsWithheld === 3);
check('and that clearance was NOT the blocker', refused.protectedAccess.cleared === true);

const granted = redaction.filterRows([rape], 'admin', REASON);
check('a granted reach is reported as granted', granted.protectedAccess.granted === true);
check('carrying the reason itself, verbatim, into the record',
  granted.protectedAccess.reason === REASON.reason);

const lowClearance = redaction.filterRows([rape], 'analyst', REASON);
check('a reach blocked by CLEARANCE is distinguishable from one blocked by no reason',
  lowClearance.protectedAccess.cleared === false);

check('an unprotected result reports no protected access at all',
  redaction.filterRows([theft], 'admin').protectedAccess === undefined);
check('the withholding is recorded as a redaction too',
  refused.redactions.some((r) => r.field === 'protected-identity' && r.action === 'withheld'));

// ── The notice the officer reads ──────────────────────────────────────────
const cleared = redaction.protectedNotice(refused.protectedAccess);
const notCleared = redaction.protectedNotice(lowClearance.protectedAccess);
check('a cleared officer is told how to unlock it', /ask again stating why/i.test(cleared));
check('and that the reason is recorded against them', /audit/i.test(cleared));
check('the notice cites the statutes it rests on', /BNS s\.72|POCSO/.test(cleared));
check('an officer whose CLEARANCE is the blocker is not sent on a dead end',
  !/stating why/i.test(notCleared) && /investigators and above/i.test(notCleared));
check('no notice when nothing was withheld',
  redaction.protectedNotice(granted.protectedAccess) === null);

// ── Coordinate coarsening ─────────────────────────────────────────────────
const located = [{ CrimeNo: '4', latitude: 12.976543, longitude: 77.575493, Total: 3 }];
const analyst = v(located, 'analyst');
check('an investigator keeps the precise coordinate',
  v(located, 'investigator').latitude === 12.976543);
check('an analyst does not', analyst.latitude !== 12.976543);
check('what they get is the ~11 km grid cell, not a deletion',
  analyst.latitude === 13 && analyst.longitude === 77.6);
check('it stays a number, so the map can still plot it',
  typeof analyst.latitude === 'number');
check('a caller with no recognised role still gets nothing',
  v(located, null).latitude === '[redacted]');

// The privacy property, stated as a distance rather than a decimal place.
check('coarsening actually destroys the doorstep — two addresses 5 km apart collapse',
  v([{ latitude: 12.9611 }], 'analyst').latitude === v([{ latitude: 13.0001 }], 'analyst').latitude);
check('while keeping the neighbourhood — Bengaluru and Mysuru stay apart',
  v([{ latitude: 12.97 }], 'analyst').latitude !== v([{ latitude: 12.29 }], 'analyst').latitude);

check('a missing coordinate does not become a number',
  v([{ latitude: null }], 'analyst').latitude === null);
check('a non-numeric coordinate is passed through untouched, not NaN',
  v([{ latitude: 'unknown' }], 'analyst').latitude === 'unknown');
check('coarsening is audited as coarsening, not as a redaction',
  redaction.filterRows(located, 'analyst').redactions
    .find((r) => r.field === 'latitude').action === 'coarsened');
check('and the record says by how much',
  /11 km/.test(redaction.filterRows(located, 'analyst').redactions
    .find((r) => r.field === 'latitude').detail));

// ── Nothing else moved ────────────────────────────────────────────────────
check('aggregates are still untouched for every role',
  v(located, 'analyst').Total === 3 && v(located, null).Total === 3);
check('calling without an options argument still works',
  redaction.filterRows([theft], 'investigator').rows[0].VictimName === 'M Iyer');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
