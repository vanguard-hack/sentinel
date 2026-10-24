/* Beat planning: patrol stops chosen from FIRs, ranked by recency, gravity,
 * shift hours and repeat offenders — with the reasons reported per stop. */
import { planBeats, SHIFTS, shiftForHour } from '../utils/patrol';

const DAY = 86400000;
const NOW = Date.UTC(2026, 5, 30);
const fir = (lat, lon, o = {}) => ({ lat, lon, ts: NOW - (o.age || 0) * DAY, hour: o.hour ?? 20, type: o.type || 'Theft', heinous: !!o.heinous, offenders: new Set(o.offenders || []) });

test('a cell with more FIRs outranks a quieter one', () => {
  const cases = [fir(12.30, 76.60), fir(12.301, 76.601), fir(12.302, 76.60), fir(12.50, 76.90)];
  const [top, second] = planBeats(cases);
  expect(top.reasons.firs).toBe(3);
  expect(second.reasons.firs).toBe(1);
});

test('recent FIRs outweigh old ones', () => {
  const cases = [fir(12.30, 76.60, { age: 400 }), fir(12.30, 76.60, { age: 400 }), fir(12.50, 76.90, { age: 1 })];
  expect(planBeats(cases)[0].reasons.firs).toBe(1);
});

test('the chosen shift pulls stops toward FIRs in those hours', () => {
  const morning = SHIFTS.find((s) => s.key === 'morning');
  const cases = [fir(12.30, 76.60, { hour: 22 }), fir(12.30, 76.60, { hour: 23 }), fir(12.50, 76.90, { hour: 9 })];
  const [top] = planBeats(cases, { shift: morning });
  expect(top.reasons.inShift).toBe(1);
});

test('heinous FIRs and repeat offenders raise a cell', () => {
  const cases = [fir(12.30, 76.60), fir(12.50, 76.90, { heinous: true, offenders: ['P1'] })];
  const [top] = planBeats(cases, { repeatPersons: new Set(['P1']) });
  expect(top.reasons.heinous).toBe(1);
  expect(top.reasons.repeat).toBe(1);
});

test('stops carry a label and the dominant crime type', () => {
  const cases = [fir(12.30, 76.60, { type: 'Burglary' }), fir(12.30, 76.60, { type: 'Burglary' }), fir(12.30, 76.60, { type: 'Theft' })];
  const [top] = planBeats(cases);
  expect(top.reasons.topType).toBe('Burglary');
  expect(top.label).toBe('Burglary area · 3 FIRs');
});

test('the result is capped and cases without coordinates are ignored', () => {
  const cases = Array.from({ length: 20 }, (_, i) => fir(12 + i * 0.1, 76)).concat([{ lat: NaN, lon: NaN }]);
  expect(planBeats(cases, { limit: 8 })).toHaveLength(8);
  expect(planBeats([{ lat: NaN, lon: NaN }])).toEqual([]);
});

test('shiftForHour maps every hour to a shift', () => {
  expect(shiftForHour(3).key).toBe('night');
  expect(shiftForHour(14).key).toBe('afternoon');
  expect(shiftForHour(23).key).toBe('evening');
});
