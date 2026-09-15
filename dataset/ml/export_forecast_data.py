#!/usr/bin/env python3
"""Build the forecasting tables for the Forecasts page, and the feature rows
the rag function sends to QuickML at prediction time.

WHAT THIS EMITS

  firvolume_train.csv    force-wide total, 1 series   -> QuickML dataset
  crimehead_train.csv    10 crime heads               -> QuickML dataset
  district_train.csv     31 districts                 -> QuickML dataset
  ../../functions/rag/forecast_features.json
                         the exact feature row for every (series, horizon)
                         the dashboard can ask for

WHY MONTHLY, NOT WEEKLY

This started weekly and the models lost to a flat per-series average. The cause
is arithmetic, not modelling. Registrations are counts, so their noise grows as
sqrt(level) while the seasonal signal grows with the level. A district
averaging 5 FIRs a week carries Poisson noise of +/-2.2 against a seasonal
swing of +/-1.7 — the signal sits underneath the noise and no model can
recover it. Bucketing to months multiplies the level by ~4.3 and the
signal-to-noise by ~2.

Measured the same way (pooled rolling-origin, leak-free), the switch is the
difference between a product and a decoration:

                    weekly            monthly
  force-wide        +11%              +65%      (MAPE 4.1%)
  crime head        -5%               +12%      (MAPE 15.6%)
  district          -2%                +7%      (MAPE 22.0%)

THE SHAPE: direct multi-horizon regression, not a forecasting pipeline

QuickML's forecasting pipelines are per-target — one series each, so 42
pipelines built by hand. These are REGRESSION tables in the direct
multi-horizon form used for global forecasting models:

    one row = (series s, origin t, horizon h)  ->  target y_s[t+h]
    features = calendar(t+h) + h + lags/rollings of s observed up to t + s

The series is a FEATURE, so one pipeline covers every series in its table.
Three pipelines, not 42.

"Direct" (h is a feature, lags always from real observed history) rather than
"recursive" (feeding predictions back as inputs): no compounding error along
the horizon, and each horizon is an independent row, so the backend never has
to chain calls.

WHY THE TOTAL GETS ITS OWN PIPELINE

It was cheaper to sum the 31 district forecasts, and that does work (+46% to
+59%). But a dedicated model is better and steadier (+64% to +67% across three
learners), because the aggregate is where the seasonal swing most clearly
clears the noise. The horizon of 6 months rather than 3 is what makes its
table large enough to train on — and it is needed anyway, since the dataset
ends in June while the dashboard has to forecast past today.

FEATURES ARE EXACTLY THE TWELVE THAT WERE MEASURED. Nothing is added here that
was not in the backtest; an unvalidated column is an unmeasured risk, and a
trend counter is deliberately absent because a tree cannot extrapolate one.

CONTIGUITY. A month with no FIRs emits 0 rather than being skipped. A skipped
month reads as a gap in time and silently mis-aligns every lag after it.
"""
import csv
import json
import os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
FIR = os.path.join(os.path.dirname(HERE), 'fir')
FUNC = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'functions', 'rag')

HORIZON = 6      # months the dashboard can forecast (30/60/90 days, plus slack)
SEASON = 12      # months in the seasonal cycle
WARMUP = 12      # first usable origin: every row then has a real seasonal lag

# The contract with functions/rag/index.js. QuickML returns null rather than
# erroring when a feature name does not match a training column, so a typo here
# fails silently and looks like a bad model.
FEATURES = [
    'series', 'horizon', 'month', 'quarter',
    'lag_1', 'lag_2', 'lag_3', 'lag_12', 'seasonal_lag_12',
    'roll_3', 'roll_6', 'roll_12',
]
TARGET = 'target_count'


def read(name):
    with open(os.path.join(FIR, f'{name}.csv'), newline='', encoding='utf-8') as fh:
        return list(csv.DictReader(fh))


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def add_months(ym, n):
    y, m = int(ym[:4]), int(ym[5:7])
    t = (y * 12 + (m - 1)) + n
    return f'{t // 12:04d}-{t % 12 + 1:02d}'


def build_series(cases, keyfn):
    """{series key: [count per month]} plus the aligned month labels.

    The final month is partial (the dataset stops mid-month) and is dropped, so
    a short month is never read as a real collapse in registrations.
    """
    counts = defaultdict(lambda: defaultdict(int))
    for c in cases:
        k = keyfn(c)
        if k is None:
            continue
        counts[k][c['CrimeRegisteredDate'][:7]] += 1

    months = sorted({m for s in counts.values() for m in s})[:-1]
    return months, {k: [counts[k].get(m, 0) for m in months] for k in sorted(counts)}


def feature_row(name, y, t, h, target_month):
    """Features for series `name`, forecasting h months past origin t.

    History is y[0..t] inclusive — index t is the last OBSERVED month, so a lag
    of k is y[t-k+1] and lag_1 is the origin itself.
    """
    def lag(k):
        i = t - k + 1
        return float(y[i]) if i >= 0 else 0.0

    def window(n):
        return [float(v) for v in y[max(0, t - n + 1): t + 1]]

    seas_i = t + h - SEASON
    mo = int(target_month[5:7])
    return {
        'series': name,
        'horizon': h,
        'month': mo,
        'quarter': (mo - 1) // 3 + 1,
        'lag_1': lag(1), 'lag_2': lag(2), 'lag_3': lag(3), 'lag_12': lag(12),
        'seasonal_lag_12': float(y[seas_i]) if 0 <= seas_i <= t else lag(1),
        'roll_3': round(mean(window(3)), 4),
        'roll_6': round(mean(window(6)), 4),
        'roll_12': round(mean(window(12)), 4),
    }


def training_rows(months, series):
    rows = []
    n = len(months)
    for name, y in series.items():
        for t in range(WARMUP, n - 1):
            for h in range(1, HORIZON + 1):
                if t + h >= n:
                    break
                r = feature_row(name, y, t, h, months[t + h])
                r[TARGET] = y[t + h]
                rows.append(r)
    return rows


def write_train(path, rows):
    with open(path, 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, fieldnames=FEATURES + [TARGET])
        w.writeheader()
        w.writerows(rows)


def flat_mean_mae(months, series):
    """The bar that actually matters: predict each series' own average.

    Naive and seasonal-naive are weak baselines for noisy counts — the mean
    beats both — so a model measured only against them can look strong while
    adding nothing.
    """
    n = len(months)
    err = []
    for y in series.values():
        for t in range(WARMUP, n - 1):
            avg = mean([float(v) for v in y[:t + 1]])
            for h in range(1, HORIZON + 1):
                if t + h >= n:
                    break
                err.append(abs(y[t + h] - avg))
    return mean(err)


def main():
    cases = read('CaseMaster')
    units = {u['UnitID']: u for u in read('Unit')}
    print('Forecast tables ->', HERE)

    specs = (
        ('firvolume', 'all', lambda c: 'all'),
        ('crimehead', 'crime_major_head', lambda c: c['CrimeMajorHeadID']),
        ('district', 'district',
         lambda c: units.get(c['PoliceStationID'], {}).get('DistrictID') or None),
    )

    tables = {}
    for key, prefix, keyfn in specs:
        months, series = build_series(cases, keyfn)
        named = ({'all': series['all']} if key == 'firvolume'
                 else {f'{prefix}_{k}': v for k, v in series.items()})

        rows = training_rows(months, named)
        write_train(os.path.join(HERE, f'{key}_train.csv'), rows)
        print(f'  {key + "_train.csv":<24} {len(rows):>6,} rows x {len(FEATURES) + 1} cols  '
              f'{len(named):>2} series  {len(months)} months   '
              f'flat-mean MAE {flat_mean_mae(months, named):.2f}')

        # The last observed month is the origin every dashboard forecast runs
        # from; its feature rows are fixed, so they are precomputed here rather
        # than recomputed per request.
        t = len(months) - 1
        tables[key] = {
            'origin_month': months[t],
            'series': sorted(named),
            'horizon': HORIZON,
            'rows': {
                name: [feature_row(name, y, t, h, add_months(months[t], h))
                       for h in range(1, HORIZON + 1)]
                for name, y in named.items()
            },
            # The observed tail, so the UI can draw history against forecast
            # without re-deriving it from the case list.
            'history': {name: y[-24:] for name, y in named.items()},
            'history_months': months[-24:],
        }

    out = os.path.join(FUNC, 'forecast_features.json')
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump({'features': FEATURES, 'target': TARGET, 'grain': 'month',
                   'tables': tables}, fh, separators=(',', ':'))
    print(f'  {"forecast_features.json":<24} {os.path.getsize(out) / 1024:>6.0f} KB  -> {FUNC}')
    print('\n  Import the three *_train.csv files as QuickML datasets, one')
    print(f'  REGRESSION pipeline each, target column "{TARGET}".')


if __name__ == '__main__':
    main()
