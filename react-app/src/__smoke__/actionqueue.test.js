import { byOfficer, countdown, citation, canCommand, SEVERITY } from '../utils/actionQueue';

// The action queue's whole value is that it sorts itself, so the ordering rules
// are the thing worth pinning: a running clock has to outrank a pile without
// one, and the nearest clock has to come first. Get that wrong and the page is
// just another list.

const ob = (over = {}) => ({
  id: 'custody-clock', caseMasterId: 'CM-1', crimeNo: '412/2026',
  ioName: 'S Kumar', station: 'Vijayanagar', severity: 'medium',
  title: 'Chargesheet due', clock: null, acknowledged: null, ...over,
});

const clock = (remainingDays) => ({ remainingDays, elapsedDays: 60 - remainingDays, windowDays: 60 });

describe('countdown', () => {
  test('days left are read as days left', () => {
    expect(countdown(clock(13))).toEqual({ text: '13 days left', over: false });
  });

  test('one day is singular', () => {
    expect(countdown(clock(1)).text).toBe('1 day left');
  });

  test('a deadline today says so rather than "0 days left"', () => {
    expect(countdown(clock(0))).toEqual({ text: 'Due today', over: true });
  });

  // A passed deadline is not "approaching" — it has already happened, and the
  // wording has to say that or an officer reads a negative number as slack.
  test('a passed deadline reports as overdue, not as negative days', () => {
    expect(countdown(clock(-4))).toEqual({ text: '4 days overdue', over: true });
    expect(countdown(clock(-1)).text).toBe('1 day overdue');
  });

  test('no clock is not a countdown of zero', () => {
    expect(countdown(null)).toBeNull();
    expect(countdown({})).toBeNull();
    expect(countdown({ remainingDays: undefined })).toBeNull();
  });
});

describe('citation', () => {
  test('the new section is paired with the familiar one', () => {
    expect(citation({ act: 'BNSS', section: '187(3)', legacy: 'CrPC 167(2)' }))
      .toBe('BNSS 187(3) · CrPC 167(2)');
  });

  test('an authority with no predecessor still renders', () => {
    expect(citation({ act: 'BSA', section: '63' })).toBe('BSA 63');
  });

  test('no authority is not a broken string', () => {
    expect(citation(null)).toBeNull();
    expect(citation(undefined)).toBeNull();
  });
});

describe('canCommand', () => {
  test('supervisors and admin get the command view', () => {
    expect(canCommand('supervisor')).toBe(true);
    expect(canCommand('admin')).toBe(true);
  });

  test('nobody else does', () => {
    ['investigator', 'analyst', 'policymaker', '', undefined, null].forEach((r) =>
      expect(canCommand(r)).toBe(false));
  });
});

describe('byOfficer', () => {
  test('obligations group under the officer holding them', () => {
    const g = byOfficer([
      ob({ ioName: 'S Kumar' }),
      ob({ ioName: 'S Kumar', caseMasterId: 'CM-2', crimeNo: '413/2026' }),
      ob({ ioName: 'A Rao' }),
    ]);
    expect(g).toHaveLength(2);
    expect(g.find((x) => x.officer === 'S Kumar').total).toBe(2);
    expect(g.find((x) => x.officer === 'S Kumar').cases).toBe(2);
  });

  test('two obligations on one case count once as a case', () => {
    const g = byOfficer([
      ob({ id: 'a' }), ob({ id: 'b' }),
    ]);
    expect(g[0].total).toBe(2);
    expect(g[0].cases).toBe(1);
  });

  // The ordering rule that makes this a command tool rather than a tally.
  test('a running clock outranks a bigger pile with no clock', () => {
    const g = byOfficer([
      ob({ ioName: 'Busy', id: 'x1' }), ob({ ioName: 'Busy', id: 'x2' }),
      ob({ ioName: 'Busy', id: 'x3' }), ob({ ioName: 'Busy', id: 'x4' }),
      ob({ ioName: 'AtRisk', severity: 'critical', clock: clock(12) }),
    ]);
    expect(g[0].officer).toBe('AtRisk');
    expect(g[1].officer).toBe('Busy');
  });

  test('within the same severity the nearest deadline comes first', () => {
    const g = byOfficer([
      ob({ ioName: 'Later', severity: 'critical', clock: clock(14) }),
      ob({ ioName: 'Sooner', severity: 'critical', clock: clock(3) }),
    ]);
    expect(g.map((x) => x.officer)).toEqual(['Sooner', 'Later']);
  });

  test('overdue sorts above everything', () => {
    const g = byOfficer([
      ob({ ioName: 'Critical', severity: 'critical', clock: clock(2) }),
      ob({ ioName: 'Overdue', severity: 'overdue', clock: clock(-1) }),
    ]);
    expect(g[0].officer).toBe('Overdue');
  });

  test('each officer reports their worst severity, not their most common', () => {
    const g = byOfficer([
      ob({ ioName: 'S Kumar', severity: 'medium', id: 'a' }),
      ob({ ioName: 'S Kumar', severity: 'medium', id: 'b' }),
      ob({ ioName: 'S Kumar', severity: 'overdue', id: 'c', clock: clock(-2) }),
    ]);
    expect(g[0].worst).toBe('overdue');
    expect(g[0].overdue).toBe(1);
  });

  test('the nearest deadline is the minimum, not the last one seen', () => {
    const g = byOfficer([
      ob({ ioName: 'S Kumar', id: 'a', clock: clock(40) }),
      ob({ ioName: 'S Kumar', id: 'b', clock: clock(5) }),
      ob({ ioName: 'S Kumar', id: 'c', clock: clock(20) }),
    ]);
    expect(g[0].soonest).toBe(5);
  });

  test('an officer with no clock running says so rather than showing zero', () => {
    const g = byOfficer([ob({ clock: null })]);
    expect(g[0].soonest).toBeNull();
  });

  // Acknowledged items are handled; counting them would tell a supervisor an
  // officer is carrying risk they have already dealt with.
  test('acknowledged obligations are excluded from the rollup', () => {
    const g = byOfficer([
      ob({ id: 'a' }),
      ob({ id: 'b', acknowledged: { by: 'kumar', at: 1, note: 'filed on paper' } }),
    ]);
    expect(g[0].total).toBe(1);
  });

  test('an all-acknowledged queue rolls up to nothing, not to an empty officer', () => {
    expect(byOfficer([ob({ acknowledged: { by: 'x', at: 1, note: 'y' } })])).toEqual([]);
  });

  test('a case with no IO recorded is grouped, not dropped', () => {
    const g = byOfficer([ob({ ioName: '' })]);
    expect(g[0].officer).toBe('Unassigned');
  });

  test('an empty queue is an empty rollup', () => {
    expect(byOfficer([])).toEqual([]);
  });

  test('an unknown severity does not break the ordering', () => {
    const g = byOfficer([ob({ severity: 'weird' }), ob({ ioName: 'B', severity: 'overdue', clock: clock(-1) })]);
    expect(g[0].officer).toBe('B');
    expect(g).toHaveLength(2);
  });
});

describe('SEVERITY', () => {
  test('ranks run worst-first so the queue can sort on them', () => {
    expect(SEVERITY.overdue.rank).toBeLessThan(SEVERITY.critical.rank);
    expect(SEVERITY.critical.rank).toBeLessThan(SEVERITY.high.rank);
    expect(SEVERITY.high.rank).toBeLessThan(SEVERITY.medium.rank);
  });

  test('every severity the engine emits has a label and a tone', () => {
    ['overdue', 'critical', 'high', 'medium', 'low'].forEach((s) => {
      expect(SEVERITY[s].label).toBeTruthy();
      expect(SEVERITY[s].tone).toBeTruthy();
    });
  });
});

// ── BNSS 43(5) ─────────────────────────────────────────────────────────────
//
// The night-arrest finding has no clock — it is about something that already
// happened, not something running out — so the card has to render without one.
// The citation carries both the new section and the CrPC one every officer
// trained before 2024 will recognise faster.

test('a night-arrest finding cites BNSS and the CrPC section it replaced', () => {
  expect(citation({ act: 'BNSS', section: '43(5)', legacy: 'CrPC 46(4)' }))
    .toBe('BNSS 43(5) · CrPC 46(4)');
});

test('an obligation with no clock renders no countdown rather than a broken one', () => {
  expect(countdown(null)).toBeNull();
  expect(countdown(undefined)).toBeNull();
});

test('a clockless high finding still outranks a clocked medium one', () => {
  expect(SEVERITY.high.rank).toBeLessThan(SEVERITY.medium.rank);
});

test('the severities the night-arrest check uses are both known to the UI', () => {
  // It emits 'high' when the arrest is clearly after dark and 'medium' when the
  // margin or the location is uncertain. An unknown severity would fall back to
  // a default chip and silently lose that distinction.
  expect(SEVERITY.high).toBeDefined();
  expect(SEVERITY.medium).toBeDefined();
});

// ── The table view ────────────────────────────────────────────────────────
//
// The queue moved from a column of tall cards to a sortable table, which put
// the ordering logic somewhere it can be tested rather than left to the order
// the server happened to return.
import { initials, avatarTone, deadlineChip, sortObligations } from '../utils/actionQueue';

test('initials come from the first and last name', () => {
  expect(initials('Umesh Sindagi')).toBe('US');
  expect(initials('A Rao')).toBe('AR');
  expect(initials('Sunitha Devi Rangappa')).toBe('SR');
});

test('a single name still yields two letters, and nothing yields a dash', () => {
  expect(initials('Rao')).toBe('RA');
  expect(initials('')).toBe('—');
  expect(initials(null)).toBe('—');
  expect(initials('   ')).toBe('—');
});

test('an officer keeps the same avatar colour across reloads', () => {
  // A chip that changes colour on refresh is noise pretending to be
  // information, so the tone is hashed from the name rather than assigned.
  expect(avatarTone('Umesh Sindagi')).toBe(avatarTone('Umesh Sindagi'));
  expect(avatarTone('A Rao')).toBe(avatarTone('A Rao'));
});

test('the deadline chip says how urgent it is as well as how long', () => {
  expect(deadlineChip({ remainingDays: 13 })).toEqual({ text: '13d left', tone: 'ok' });
  expect(deadlineChip({ remainingDays: 4 })).toEqual({ text: '4d left', tone: 'soon' });
  expect(deadlineChip({ remainingDays: 0 })).toEqual({ text: 'Today', tone: 'over' });
  expect(deadlineChip({ remainingDays: -4 })).toEqual({ text: '4d over', tone: 'over' });
});

test('an obligation with no clock gets a dash, not an invented countdown', () => {
  // The night-arrest finding is about something that already happened.
  expect(deadlineChip(null)).toEqual({ text: '—', tone: 'none' });
  expect(deadlineChip({})).toEqual({ text: '—', tone: 'none' });
});

const row = (over = {}) => ({
  severity: 'medium', crimeNo: '412/2026', title: 'B', kind: 'procedural',
  ioName: 'B Officer', clock: null, ...over,
});

test('the default sort puts the worst first', () => {
  const sorted = sortObligations([
    row({ severity: 'high', title: 'h' }),
    row({ severity: 'overdue', title: 'o' }),
    row({ severity: 'critical', title: 'c' }),
  ]);
  expect(sorted.map((o) => o.title)).toEqual(['o', 'c', 'h']);
});

test('sorting by another column still breaks ties on severity', () => {
  // Two rows for the same officer are not equally urgent, and leaving their
  // order to chance would make the table meaningless where it matters most.
  const sorted = sortObligations([
    row({ ioName: 'A Rao', severity: 'medium', title: 'mid' }),
    row({ ioName: 'A Rao', severity: 'overdue', title: 'bad' }),
  ], 'officer');
  expect(sorted.map((o) => o.title)).toEqual(['bad', 'mid']);
});

test('sorting by deadline puts the nearest clock first and the clockless last', () => {
  const sorted = sortObligations([
    row({ title: 'none' }),
    row({ title: 'far', clock: { remainingDays: 40 } }),
    row({ title: 'over', clock: { remainingDays: -2 } }),
  ], 'deadline');
  expect(sorted.map((o) => o.title)).toEqual(['over', 'far', 'none']);
});

test('the direction can be reversed without losing the tie-break', () => {
  const asc = sortObligations([row({ crimeNo: '1' }), row({ crimeNo: '2' })], 'crimeNo', 'asc');
  const desc = sortObligations([row({ crimeNo: '1' }), row({ crimeNo: '2' })], 'crimeNo', 'desc');
  expect(asc.map((o) => o.crimeNo)).toEqual(['1', '2']);
  expect(desc.map((o) => o.crimeNo)).toEqual(['2', '1']);
});

test('sorting never mutates the list it was given', () => {
  const list = [row({ severity: 'medium' }), row({ severity: 'overdue' })];
  const before = list.map((o) => o.severity);
  sortObligations(list);
  expect(list.map((o) => o.severity)).toEqual(before);
});

test('an unknown sort key falls back to severity rather than shuffling', () => {
  const sorted = sortObligations([
    row({ severity: 'high', title: 'h' }),
    row({ severity: 'overdue', title: 'o' }),
  ], 'nonsense');
  expect(sorted.map((o) => o.title)).toEqual(['o', 'h']);
});

// ── Pagination ────────────────────────────────────────────────────────────
//
// Sixty-one obligations is a scroll nobody finishes. The interesting part is
// not slicing an array — it is that every filter on this page can shrink the
// list under the reader's feet, and a page index left pointing past the end
// renders an empty table under a header claiming sixty-one rows.
import { paginate, pageWindow, PAGE_SIZES } from '../utils/actionQueue';

const list = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

test('a page carries the rows it should', () => {
  const v = paginate(list(61), 1, 15);
  expect(v.rows).toHaveLength(15);
  expect(v.rows[0].id).toBe(1);
  expect(v.pages).toBe(5);
  expect(v.total).toBe(61);
});

test('the last page carries the remainder, not a padded full page', () => {
  const v = paginate(list(61), 5, 15);
  expect(v.rows).toHaveLength(1);
  expect(v.rows[0].id).toBe(61);
});

test('the count reads the way a person says it', () => {
  const v = paginate(list(61), 2, 15);
  expect([v.first, v.last]).toEqual([16, 30]);
});

test('an empty queue reports 0 of 0 rather than 1 to 0', () => {
  const v = paginate([], 1, 15);
  expect([v.first, v.last, v.total, v.pages]).toEqual([0, 0, 0, 1]);
});

test('a page past the end is clamped to the last one', () => {
  // The case that matters: on page 4, switch to "Mine", three rows survive.
  const v = paginate(list(3), 4, 15);
  expect(v.page).toBe(1);
  expect(v.rows).toHaveLength(3);
});

test('nonsense page numbers do not produce an empty table', () => {
  [0, -3, NaN, null, undefined, 'two'].forEach((p) => {
    const v = paginate(list(20), p, 15);
    expect(v.page).toBe(1);
    expect(v.rows.length).toBeGreaterThan(0);
  });
});

test('a nonsense page size falls back rather than dividing by zero', () => {
  [0, -10, NaN, null].forEach((n) => {
    const v = paginate(list(20), 1, n);
    expect(v.size).toBe(PAGE_SIZES[0]);
    expect(v.rows).toHaveLength(15);
  });
});

test('paginating never mutates the list it was given', () => {
  const rows = list(5);
  paginate(rows, 1, 2);
  expect(rows).toHaveLength(5);
});

// ── The page buttons ──────────────────────────────────────────────────────

test('a single page needs no window', () => {
  expect(pageWindow(1, 1)).toEqual([1]);
});

test('every page is shown when they all fit', () => {
  expect(pageWindow(2, 4)).toEqual([1, 2, 3, 4]);
});

test('the first, last and current pages are always reachable', () => {
  const w = pageWindow(20, 40);
  expect(w[0]).toBe(1);
  expect(w[w.length - 1]).toBe(40);
  expect(w).toContain(20);
});

test('a gap marks what was skipped, so the control keeps its width', () => {
  expect(pageWindow(20, 40)).toEqual([1, 'gap', 19, 20, 21, 'gap', 40]);
});

test('no gap is drawn for a single skipped page — the number is shorter', () => {
  expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
});

test('the window does not run past either end', () => {
  expect(pageWindow(1, 10)).toEqual([1, 2, 'gap', 10]);
  expect(pageWindow(10, 10)).toEqual([1, 'gap', 9, 10]);
});

test('a page number is never repeated', () => {
  const w = pageWindow(2, 6).filter((n) => n !== 'gap');
  expect(new Set(w).size).toBe(w.length);
});
