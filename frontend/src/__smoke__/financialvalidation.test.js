/* Financial Trails model validation: does the score separate the planted
 * laundering profiles from the planted "ordinary" baseline, and is the
 * confusion matrix/AUC/calibration math sane at the edges (a perfect
 * separator, a useless one, an empty population)?
 *
 * validateFinancialTrails takes the already-scored population directly, so
 * these fixtures skip the transaction synthesis entirely — the thing under
 * test is the measurement, not the generator.
 */
import { validateFinancialTrails, scoreBreakdown } from '../utils/financial';

const entity = (person, profile, typologies, score) => ({
  person, name: person, profile, typologies, score,
  tier: score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low',
  value: 0, txnCount: 1, flaggedCount: 0, inDistinct: 0, outDistinct: 0, firs: [],
});

test('a perfect separator scores AUC 1 and a clean confusion matrix', () => {
  const scored = [
    ...Array.from({ length: 5 }, (_, i) => entity(`L${i}`, 'layerer', ['layering'], 80)),
    ...Array.from({ length: 5 }, (_, i) => entity(`O${i}`, 'ordinary', [], 5)),
  ];
  const v = validateFinancialTrails(scored);
  expect(v.auc).toBe(1);
  expect(v.confusion).toEqual(expect.objectContaining({ tp: 5, fp: 0, tn: 5, fn: 0 }));
  expect(v.confusion.precision).toBe(1);
  expect(v.confusion.recall).toBe(1);
  expect(v.confusion.mcc).toBe(1);
});

test('a rule that fires on everyone catches every case and no clean one', () => {
  const scored = [
    ...Array.from({ length: 4 }, (_, i) => entity(`L${i}`, 'layerer', ['shellMule'], 50)),
    ...Array.from({ length: 4 }, (_, i) => entity(`O${i}`, 'ordinary', ['shellMule'], 50)),
  ];
  const v = validateFinancialTrails(scored);
  expect(v.confusion).toEqual(expect.objectContaining({ tp: 4, fp: 4, tn: 0, fn: 0 }));
  expect(v.confusion.recall).toBe(1);
  // Every case flagged regardless of ground truth: precision is exactly the
  // base rate, not evidence the rule is discriminating between anything.
  expect(v.confusion.precision).toBe(0.5);
});

test('an empty population is reported as no measurement, not as a zero', () => {
  const v = validateFinancialTrails([]);
  expect(v.population).toBe(0);
  expect(v.auc).toBeNull();
  expect(v.confusion.precision).toBeNull();
  expect(v.confusion.mcc).toBeNull();
  expect(v.calibration).toBeNull();
});

test('a population with only one ground-truth class reports AUC as unmeasurable', () => {
  const scored = Array.from({ length: 6 }, (_, i) => entity(`O${i}`, 'ordinary', [], 10 + i));
  const v = validateFinancialTrails(scored);
  expect(v.auc).toBeNull(); // no positives to rank against
  expect(v.confusion.fp + v.confusion.tn).toBe(6);
});

test('score breakdown items sum close to the score and are sorted highest first', () => {
  const alert = { typologies: ['layering', 'shellMule'], value: 6_000_000, score: 33 };
  const items = scoreBreakdown(alert);
  expect(items.map((i) => i.key)).toEqual(['layering', 'value', 'shellMule']);
  const total = items.reduce((s, i) => s + i.points, 0);
  // Each item is independently rounded, so the sum can be off from the score
  // by at most a point or two of rounding drift, never wildly.
  expect(Math.abs(total - alert.score)).toBeLessThanOrEqual(3);
});

test('a typology with zero rounded value points is still listed', () => {
  const items = scoreBreakdown({ typologies: ['highCash'], value: 0 });
  expect(items).toEqual([{ key: 'highCash', label: 'High-value cash', points: 9 }]);
});
