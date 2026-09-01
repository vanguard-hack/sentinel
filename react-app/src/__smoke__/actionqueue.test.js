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
