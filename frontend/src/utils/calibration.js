// Does a score mean what it says?
//
// AUC (.87 here) measures RANKING — whether real matches sort near the top —
// and says nothing about the number itself: a model scoring every true link
// 0.95 and every false one 0.90 has a perfect AUC with meaningless numbers.
// Officers read the number, not the rank. So this module bins predictions,
// compares each bin's mean prediction to what actually happened, and reports
// the gap as a Brier score + Expected Calibration Error, plus an isotonic fit
// that corrects the scores without touching their order (AUC unchanged).
//
// validate() samples unlinked pairs 1:1 with linked ones for AUC, but true
// links are a fraction of a percent of all pairs — a calibrator fit on that
// 50% sample overstates every probability by two orders of magnitude, and
// the reliability curve against the sample looks convincingly straight
// anyway. Fix: weight each sampled pair by how many pairs of its class it
// stands for (the standard case-control correction) — every function here
// takes weights for this reason.
//
// Isotonic regression, not a sigmoid: it's monotone and non-parametric, so it
// can reshape the score-to-probability mapping without ever reordering it —
// exactly what's needed when ranking is already good (AUC .87) but the shape
// is wrong, and it guarantees the correction can't change the AUC.

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

// AUC via the Mann-Whitney rank statistic (ties get average ranks) — the
// probability that a random positive outscores a random negative. Scale-free,
// so raw scores (0-100, 0-1, whatever) work without normalising first.
export function rocAuc(positiveScores, negativeScores) {
  const all = [
    ...positiveScores.map((s) => ({ s, positive: 1 })),
    ...negativeScores.map((s) => ({ s, positive: 0 })),
  ].sort((x, y) => x.s - y.s);
  let i = 0;
  let rankSum = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].s === all[i].s) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (all[k].positive) rankSum += avgRank;
    i = j + 1;
  }
  const n1 = positiveScores.length;
  const n2 = negativeScores.length;
  if (!n1 || !n2) return null;
  return (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n2);
}

// Swets (1988) interpretation bands, as used across the linkage literature.
export function aucBand(auc) {
  if (auc == null) return '';
  if (auc >= 0.9) return 'high accuracy';
  if (auc >= 0.7) return 'moderate accuracy';
  if (auc >= 0.5) return 'low accuracy';
  return 'non-informative';
}

/**
 * Precision / recall / F1 / MCC from a confusion matrix at one operating
 * threshold. AUC and calibration both describe the score as a whole; this is
 * the question an officer asks about the SPECIFIC threshold the tool actually
 * flags at today — how many of the flags are real, how many reals get missed.
 *
 * MCC (Matthews Correlation Coefficient) is included alongside the more
 * familiar precision/recall/F1 because, unlike them, it uses all four
 * confusion-matrix cells at once and stays meaningful under heavy class
 * imbalance — the property the fraud-detection literature singles it out for.
 */
export function confusionMetrics(tp, fp, tn, fn) {
  const total = tp + fp + tn + fn;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision != null && recall != null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;
  const mccDenomSq = (tp + fp) * (tp + fn) * (tn + fp) * (tn + fn);
  const mcc = mccDenomSq > 0 ? (tp * tn - fp * fn) / Math.sqrt(mccDenomSq) : null;
  return {
    tp, fp, tn, fn, total,
    accuracy: total > 0 ? (tp + tn) / total : null,
    precision, recall, f1, mcc,
  };
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
