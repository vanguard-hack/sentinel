import {
  fitIsotonic, applyIsotonic, reliability, brier, ece, calibrationBand, assess,
} from '../utils/calibration';

// Calibration is easy to get subtly, invisibly wrong: a broken implementation
// still produces a plausible table of numbers. So these tests build models
// whose true calibration is known by construction and check the maths recovers
// it — a perfectly calibrated model must score near zero, an overconfident one
// must be caught, and the base-rate weighting must actually bite.

// A deterministic generator, so a failure is reproducible.
const rng = (seed = 12345) => () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

/** n samples where the label really does occur with probability = the score. */
const wellCalibrated = (n = 4000, seed = 7) => {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const x = r();
    return { x, y: r() < x ? 1 : 0, w: 1 };
  });
};

/** Same ranking, but every probability inflated — the failure AUC cannot see. */
const overconfident = (n = 4000, seed = 11) => {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const x = r();
    const truth = x * 0.5;          // it says x, reality is half that
    return { x, y: r() < truth ? 1 : 0, w: 1 };
  });
};

describe('fitIsotonic', () => {
  test('a monotone fit comes back non-decreasing', () => {
    const fit = fitIsotonic(wellCalibrated(2000).map((s) => ({ x: s.x, y: s.y, w: 1 })));
    for (let i = 1; i < fit.length; i++) {
      expect(fit[i].value).toBeGreaterThanOrEqual(fit[i - 1].value);
    }
  });

  test('violations are pooled rather than preserved', () => {
    // Deliberately inverted: high score, low outcome.
    const fit = fitIsotonic([
      { x: 0.1, y: 1, w: 1 }, { x: 0.2, y: 1, w: 1 },
      { x: 0.8, y: 0, w: 1 }, { x: 0.9, y: 0, w: 1 },
    ]);
    for (let i = 1; i < fit.length; i++) {
      expect(fit[i].value).toBeGreaterThanOrEqual(fit[i - 1].value);
    }
  });

  test('weights change the fitted value', () => {
    const light = fitIsotonic([{ x: 0.5, y: 1, w: 1 }, { x: 0.5, y: 0, w: 1 }]);
    const heavy = fitIsotonic([{ x: 0.5, y: 1, w: 1 }, { x: 0.5, y: 0, w: 9 }]);
    expect(light[0].value).toBeCloseTo(0.5, 5);
    expect(heavy[0].value).toBeCloseTo(0.1, 5);
  });

  test('identical scores cannot be given two different probabilities', () => {
    const fit = fitIsotonic([{ x: 0.4, y: 1, w: 1 }, { x: 0.4, y: 0, w: 1 }, { x: 0.9, y: 1, w: 1 }]);
    const atPoint = fit.filter((b) => b.minX <= 0.4 && b.maxX >= 0.4);
    expect(atPoint).toHaveLength(1);
  });

  test('no usable samples is an empty fit, not a crash', () => {
    expect(fitIsotonic([])).toEqual([]);
    expect(fitIsotonic(null)).toEqual([]);
    expect(fitIsotonic([{ x: NaN, y: 1, w: 1 }, { x: 0.5, y: 1, w: 0 }])).toEqual([]);
  });
});

describe('applyIsotonic', () => {
  const fit = fitIsotonic([
    { x: 0.1, y: 0, w: 100 }, { x: 0.5, y: 0, w: 60 },
    { x: 0.5, y: 1, w: 40 }, { x: 0.9, y: 1, w: 100 },
  ]);

  test('a score inside the data maps to its block', () => {
    expect(applyIsotonic(fit, 0.5)).toBeCloseTo(0.4, 5);
  });

  // Beyond the data there is no evidence about what the probability does, and
  // a confident extrapolation is exactly the failure this module exists for.
  test('below the data it clips rather than extrapolating', () => {
    expect(applyIsotonic(fit, 0)).toBe(fit[0].value);
    expect(applyIsotonic(fit, -5)).toBe(fit[0].value);
  });

  test('above the data it clips too', () => {
    expect(applyIsotonic(fit, 1)).toBe(fit[fit.length - 1].value);
    expect(applyIsotonic(fit, 99)).toBe(fit[fit.length - 1].value);
  });

  test('the correction never reorders two scores', () => {
    const xs = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95];
    const ps = xs.map((x) => applyIsotonic(fit, x));
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThanOrEqual(ps[i - 1]);
  });

  test('an empty fit yields nothing rather than a wrong number', () => {
    expect(applyIsotonic([], 0.5)).toBeNull();
    expect(applyIsotonic(fit, NaN)).toBeNull();
  });
});

describe('reliability', () => {
  test('a well-calibrated model has small gaps in every populated bin', () => {
    const bins = reliability(wellCalibrated(20000), 10);
    bins.forEach((b) => expect(Math.abs(b.gap)).toBeLessThan(0.05));
  });

  test('an overconfident model shows a positive gap that grows with the score', () => {
    const bins = reliability(overconfident(20000), 10);
    const top = bins[bins.length - 1];
    const bottom = bins[0];
    expect(top.gap).toBeGreaterThan(0.3);
    expect(top.gap).toBeGreaterThan(bottom.gap);
  });

  test('empty bins are dropped, not reported as zero-accuracy', () => {
    const bins = reliability([{ x: 0.95, y: 1, w: 1 }], 10);
    expect(bins).toHaveLength(1);
    expect(bins[0].lo).toBeCloseTo(0.9, 5);
  });

  test('a score of exactly 1 lands in the top bin, not off the end', () => {
    const bins = reliability([{ x: 1, y: 1, w: 1 }], 10);
    expect(bins).toHaveLength(1);
    expect(bins[0].hi).toBeCloseTo(1, 5);
  });

  // The weighting is the whole reason this module can speak about reality.
  test('weights, not counts, decide the observed rate', () => {
    const bins = reliability([
      { x: 0.5, y: 1, w: 1 },
      { x: 0.5, y: 0, w: 99 },
    ], 10);
    expect(bins[0].observedRate).toBeCloseTo(0.01, 5);
    expect(bins[0].n).toBe(2);
  });
});

describe('brier and ece', () => {
  test('a perfect predictor scores zero', () => {
    expect(brier([{ x: 1, y: 1, w: 1 }, { x: 0, y: 0, w: 1 }]).score).toBeCloseTo(0, 6);
  });

  test('a coin flip on a balanced problem scores 0.25', () => {
    expect(brier([{ x: 0.5, y: 1, w: 1 }, { x: 0.5, y: 0, w: 1 }]).score).toBeCloseTo(0.25, 6);
  });

  // The number is meaningless without something to compare it against, so the
  // reference marks travel with it.
  test('it reports what ignoring the model entirely would score', () => {
    const b = brier(wellCalibrated(5000));
    expect(b.baseRate).toBeGreaterThan(0);
    expect(b.baseRateScore).toBeCloseTo(b.baseRate * (1 - b.baseRate), 6);
    expect(b.coinFlip).toBe(0.25);
  });

  test('a well-calibrated model beats the base-rate predictor', () => {
    const b = brier(wellCalibrated(20000));
    expect(b.score).toBeLessThan(b.baseRateScore);
  });

  test('ECE is near zero when the model is honest', () => {
    expect(ece(reliability(wellCalibrated(20000), 10))).toBeLessThan(0.03);
  });

  test('ECE is large when the model is overconfident', () => {
    expect(ece(reliability(overconfident(20000), 10))).toBeGreaterThan(0.15);
  });

  test('no data gives null rather than a confident zero', () => {
    expect(brier([])).toBeNull();
    expect(ece([])).toBeNull();
  });

  test('the bands match the thresholds quoted to the officer', () => {
    expect(calibrationBand(0.02)).toBe('well calibrated');
    expect(calibrationBand(0.07)).toBe('reasonable');
    expect(calibrationBand(0.2)).toBe('needs calibration');
    expect(calibrationBand(null)).toBe('');
  });
});

describe('assess', () => {
  test('an honest model is reported as already calibrated', () => {
    const a = assess(wellCalibrated(20000));
    expect(a.ece).toBeLessThan(0.05);
    expect(a.band).toBe('well calibrated');
  });

  test('an overconfident model is caught and the fix measured', () => {
    const a = assess(overconfident(20000));
    expect(a.ece).toBeGreaterThan(0.15);
    expect(a.calibratedEce).toBeLessThan(a.ece);
    expect(a.improved).toBe(true);
    expect(a.calibratedBand).toBe('well calibrated');
  });

  test('calibration improves the Brier score too', () => {
    const a = assess(overconfident(20000));
    expect(a.calibratedBrier.score).toBeLessThan(a.brier.score);
  });

  // The point of isotonic: the ranking that AUC measures is left untouched.
  test('the correction is monotone, so it cannot change the ranking', () => {
    const a = assess(overconfident(8000));
    const xs = [0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
    const ps = xs.map((x) => applyIsotonic(a.fit, x));
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThanOrEqual(ps[i - 1]);
  });

  test('nothing to assess returns null rather than an empty verdict', () => {
    expect(assess([])).toBeNull();
    expect(assess(null)).toBeNull();
    expect(assess([{ x: NaN, y: 1 }])).toBeNull();
  });
});

// THE TRAP THIS MODULE EXISTS TO AVOID.
//
// Case Linkage samples unlinked pairs one-for-one with linked pairs, because
// that is what AUC needs. Fit a calibrator on that sample without weighting and
// the reliability curve looks beautiful against a 50/50 world that does not
// exist, while every probability is overstated by two orders of magnitude.
describe('base-rate weighting', () => {
  const r = rng(99);
  // A rare event: 1% of pairs are genuinely linked. The model's raw score is
  // informative but is not a probability.
  const positives = Array.from({ length: 500 }, () => ({ x: 0.4 + r() * 0.6, y: 1 }));
  const negatives = Array.from({ length: 500 }, () => ({ x: r() * 0.7, y: 0 }));
  const TRUE_BASE = 0.01;
  const wPos = 1;
  const wNeg = ((1 - TRUE_BASE) / TRUE_BASE) * (positives.length / negatives.length);

  test('without weighting the fit reports a ~50% world', () => {
    const unweighted = assess([...positives, ...negatives].map((s) => ({ ...s, w: 1 })));
    expect(unweighted.brier.baseRate).toBeCloseTo(0.5, 1);
  });

  test('with weighting it reports the real base rate', () => {
    const weighted = assess([
      ...positives.map((s) => ({ ...s, w: wPos })),
      ...negatives.map((s) => ({ ...s, w: wNeg })),
    ]);
    expect(weighted.brier.baseRate).toBeCloseTo(TRUE_BASE, 2);
  });

  // Probed inside the region where both classes actually occur (0.4-0.7).
  // Above 0.7 this fixture has no negatives at all, so isotonic returns 1.0
  // whatever the prior — correctly, since every observed pair up there was
  // linked. Weighting can only bite where the classes overlap.
  test('and the probabilities it produces are far lower than the unweighted ones', () => {
    const unweighted = assess([...positives, ...negatives].map((s) => ({ ...s, w: 1 })));
    const weighted = assess([
      ...positives.map((s) => ({ ...s, w: wPos })),
      ...negatives.map((s) => ({ ...s, w: wNeg })),
    ]);
    const overlapping = 0.55;
    expect(applyIsotonic(weighted.fit, overlapping))
      .toBeLessThan(applyIsotonic(unweighted.fit, overlapping) / 2);
  });

  // A block fitted from a handful of pairs can read 100% while resting on
  // almost nothing. The fit therefore carries the weight behind each block so
  // the UI can hedge instead of printing a confident number from thin support.
  test('every fitted block reports the support behind it', () => {
    const weighted = assess([
      ...positives.map((s) => ({ ...s, w: wPos })),
      ...negatives.map((s) => ({ ...s, w: wNeg })),
    ]);
    weighted.fit.forEach((b) => expect(b.weight).toBeGreaterThan(0));
  });
});
