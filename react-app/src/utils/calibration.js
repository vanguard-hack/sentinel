// Does a score mean what it says?
//
// THE QUESTION AUC CANNOT ANSWER
//
// Case Linkage reports an ROC AUC of about .87. AUC measures RANKING — the
// probability that a random linked pair outscores a random unlinked one. It is
// the right metric for "does the model put the real matches near the top", and
// on that question .87 is a good answer.
//
// It says nothing whatever about the number on the screen. A model that scores
// every true link at 0.95 and every false one at 0.90 has a perfect AUC of 1.0
// and its numbers are nonsense: the things it calls 90% are almost never true.
// Ranking and calibration come apart completely, and the officer reads the
// number, not the ranking. Nobody has ever thought "this pair is ranked third
// of five hundred"; they think "87% — that is nearly certain".
//
// So this module measures the other half: bin the predictions, compare each
// bin's mean prediction against what actually happened in it, and report the
// gap. Two numbers come out — the Brier score and the Expected Calibration
// Error — plus an isotonic fit that corrects the scores without touching their
// order, so the AUC is unchanged and only the printed number moves.
//
// THE BASE-RATE TRAP, WHICH IS THE WHOLE DIFFICULTY HERE
//
// validate() samples unlinked pairs one-for-one with linked pairs, because
// that is what AUC needs and AUC is insensitive to class balance. Calibration
// is not. Among all pairs of cases the true rate of linked pairs is a fraction
// of a percent; in a 1:1 sample it is 50%. Fit a calibrator on the sample and
// every probability it produces is overstated by two orders of magnitude — and
// it would look convincing, because the reliability curve against the SAMPLE
// would come out beautifully straight.
//
// The fix is the standard correction for case-control sampling: weight each
// sampled pair by how many pairs of its class it stands for. Every function
// here therefore takes weights, and the weights are what make the answer a
// statement about the real world rather than about the sample.
//
// WHY ISOTONIC AND NOT A SIGMOID
//
// Isotonic regression is monotone and non-parametric: it can only reorder
// nothing and reshape anything. That is exactly this model's profile — the
// ranking is already good (AUC .87), so the shape of the score-to-probability
// mapping is what is wrong, and forcing it through a two-parameter sigmoid
// would impose a shape the data has no reason to take. Being monotone also
// guarantees the correction cannot change the AUC, so calibrating costs
// nothing that was already working.

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Weighted isotonic regression by pool-adjacent-violators.
 *
 * Returns blocks of the fitted step function, each covering an x-range with a
 * single fitted probability. Monotone non-decreasing by construction, which is
 * what makes this safe to apply to a score whose ranking is already trusted.
 */
export function fitIsotonic(samples) {
  const pts = (samples || [])
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && (p.w ?? 1) > 0)
    .sort((a, b) => a.x - b.x);
  if (!pts.length) return [];

  // Identical x values must share a block, or the fit could imply two different
  // probabilities for the same score.
  const blocks = [];
  for (const p of pts) {
    const w = p.w ?? 1;
    const last = blocks[blocks.length - 1];
    if (last && last.maxX === p.x) {
      last.w += w;
      last.wy += w * p.y;
    } else {
      blocks.push({ minX: p.x, maxX: p.x, w, wy: w * p.y });
    }
  }

  // Pool adjacent violators: while a block's mean is below its predecessor's,
  // merge them. Repeated until the sequence is non-decreasing.
  const out = [];
  for (const b of blocks) {
    out.push(b);
    while (out.length > 1) {
      const cur = out[out.length - 1];
      const prev = out[out.length - 2];
      if (prev.wy / prev.w <= cur.wy / cur.w) break;
      out.pop();
      out.pop();
      out.push({ minX: prev.minX, maxX: cur.maxX, w: prev.w + cur.w, wy: prev.wy + cur.wy });
    }
  }

  return out.map((b) => ({ minX: b.minX, maxX: b.maxX, value: clamp01(b.wy / b.w), weight: b.w }));
}

/**
 * How much evidence stands behind the block a score falls in.
 *
 * Isotonic will happily fit 1.0 to a region where every observed pair happened
 * to be linked, even if that region holds three pairs. The value is not wrong,
 * but it is fragile, and a screen that prints "100%" off three pairs is making
 * a promise the data cannot keep. Returning the support lets the caller say so.
 */
export function isotonicSupport(fit, x) {
  if (!fit || !fit.length || !Number.isFinite(x)) return 0;
  for (const b of fit) if (x >= b.minX && x <= b.maxX) return b.weight;
  if (x <= fit[0].maxX) return fit[0].weight;
  if (x >= fit[fit.length - 1].minX) return fit[fit.length - 1].weight;
  return 0;
}

/**
 * Apply a fit to one score.
 *
 * Out of range clips to the nearest end rather than extrapolating: beyond the
 * data there is no evidence about what the probability does, and a confident
 * extrapolation is the specific failure this whole module exists to catch.
 */
export function applyIsotonic(fit, x) {
  if (!fit || !fit.length || !Number.isFinite(x)) return null;
  if (x <= fit[0].maxX) return fit[0].value;
  if (x >= fit[fit.length - 1].minX) return fit[fit.length - 1].value;
  for (let i = 0; i < fit.length; i++) {
    if (x >= fit[i].minX && x <= fit[i].maxX) return fit[i].value;
    // Between two blocks: interpolate so neighbouring scores do not jump.
    if (i + 1 < fit.length && x > fit[i].maxX && x < fit[i + 1].minX) {
      const span = fit[i + 1].minX - fit[i].maxX;
      const t = span > 0 ? (x - fit[i].maxX) / span : 0;
      return clamp01(fit[i].value + t * (fit[i + 1].value - fit[i].value));
    }
  }
  return fit[fit.length - 1].value;
}

/**
 * The reliability curve: what the model said, against what actually happened.
 *
 * This is the table that settles the argument. If the 0.8–0.9 bin holds a
 * hundred pairs the model called 85% and sixty of them were genuinely linked,
 * the model is overconfident by 25 points and the number on the screen is
 * misleading an officer.
 */
export function reliability(samples, binCount = 10) {
  const bins = [];
  for (let i = 0; i < binCount; i++) {
    const lo = i / binCount;
    const hi = (i + 1) / binCount;
    bins.push({ lo, hi, w: 0, wPred: 0, wObs: 0, n: 0 });
  }
  for (const s of samples || []) {
    if (!Number.isFinite(s.x)) continue;
    const w = s.w ?? 1;
    let idx = Math.floor(clamp01(s.x) * binCount);
    if (idx >= binCount) idx = binCount - 1;
    const b = bins[idx];
    b.w += w;
    b.wPred += w * clamp01(s.x);
    b.wObs += w * (s.y ? 1 : 0);
    b.n += 1;
  }
  return bins
    .filter((b) => b.w > 0)
    .map((b) => ({
      lo: b.lo,
      hi: b.hi,
      n: b.n,
      weight: b.w,
      meanPredicted: b.wPred / b.w,
      observedRate: b.wObs / b.w,
      gap: b.wPred / b.w - b.wObs / b.w,
    }));
}

/**
 * Brier score — mean squared error of the probabilities. Lower is better,
 * 0 is perfect.
 *
 * The number is meaningless alone, so the two reference marks that make it
 * readable are returned with it: what you would score by ignoring the model
 * and always predicting the base rate, and 0.25 for a coin flip. A model that
 * cannot beat the base-rate predictor is adding nothing.
 */
export function brier(samples) {
  let w = 0;
  let se = 0;
  let wy = 0;
  for (const s of samples || []) {
    if (!Number.isFinite(s.x)) continue;
    const ww = s.w ?? 1;
    const y = s.y ? 1 : 0;
    w += ww;
    se += ww * (clamp01(s.x) - y) ** 2;
    wy += ww * y;
  }
  if (!w) return null;
  const base = wy / w;
  return {
    score: se / w,
    baseRate: base,
    baseRateScore: base * (1 - base),
    coinFlip: 0.25,
  };
}

/**
 * Expected Calibration Error — the average gap between what was predicted and
 * what happened, weighted by how much sits in each bin.
 *
 * One number, and the one worth quoting: "on average our stated confidence is
 * off by N percentage points". Under 5% is well calibrated; over 10% needs
 * fixing.
 */
export function ece(bins) {
  const total = (bins || []).reduce((a, b) => a + b.weight, 0);
  if (!total) return null;
  return bins.reduce((a, b) => a + (b.weight / total) * Math.abs(b.gap), 0);
}

export function calibrationBand(e) {
  if (e == null) return '';
  if (e < 0.05) return 'well calibrated';
  if (e < 0.10) return 'reasonable';
  return 'needs calibration';
}

/**
 * Run the whole assessment over a weighted sample.
 *
 * Reports the model as it stands AND as it would be after the isotonic
 * correction, because the pair of numbers is the argument: "off by 9 points
 * today, off by 1 after the fix" says both that there is a problem and that it
 * is solved, which neither figure says alone.
 */
export function assess(samples, binCount = 10) {
  const clean = (samples || []).filter((s) => Number.isFinite(s.x));
  if (!clean.length) return null;

  const rawBins = reliability(clean, binCount);
  const rawBrier = brier(clean);
  const rawEce = ece(rawBins);

  const fit = fitIsotonic(clean.map((s) => ({ x: s.x, y: s.y ? 1 : 0, w: s.w ?? 1 })));
  const calibrated = clean.map((s) => ({ ...s, x: applyIsotonic(fit, s.x) ?? s.x }));
  const calBins = reliability(calibrated, binCount);
  const calBrier = brier(calibrated);
  const calEce = ece(calBins);

  return {
    samples: clean.length,
    bins: rawBins,
    calibratedBins: calBins,
    brier: rawBrier,
    calibratedBrier: calBrier,
    ece: rawEce,
    calibratedEce: calEce,
    band: calibrationBand(rawEce),
    calibratedBand: calibrationBand(calEce),
    fit,
    improved: rawEce != null && calEce != null && calEce < rawEce,
  };
}
