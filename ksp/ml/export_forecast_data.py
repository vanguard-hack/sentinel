#!/usr/bin/env python3
"""Build the forecasting tables for the Forecasts page, and the feature rows
the rag function sends to QuickML at prediction time.

WHAT THIS EMITS

  crimehead_volume_forecast.csv   raw weekly series, 10 crime heads   (wide)
  district_volume_forecast.csv    raw weekly series, 31 districts     (wide)
  crimehead_train.csv             SUPERVISED table -> QuickML dataset
  district_train.csv              SUPERVISED table -> QuickML dataset
  ../../functions/rag/forecast_features.json
                                  the exact feature row for every
                                  (series, horizon) the dashboard can ask for

THE SHAPE, AND WHY IT IS NOT A "FORECASTING" PIPELINE

QuickML's forecasting pipelines are per-target: a univariate one models one
series, and the multivariate (VAR) one predicts a single target using the
others as helpers. Covering 10 crime heads and 31 districts that way is 41
pipelines built by hand in the console. So instead these are REGRESSION tables
in the direct multi-horizon form used for global forecasting models:

    one row = (series s, origin t, horizon h)  ->  target y_s[t+h]
    features = calendar(t+h) + h + lags/rollings of s observed up to t + s

One pipeline then covers every series in its table, because the series is a
feature rather than a separate model. Two pipelines, not 41.

"Direct" (h is a feature, lags always measured from real observed history)
rather than "recursive" (feeding predictions back in as inputs): no compounding
error along the horizon, and each horizon is an independent row, so the backend
never chains calls.

WHY THERE IS NO FORCE-WIDE PIPELINE

The force-wide weekly total gets a worse forecast from its own model than from
summing the 31 district forecasts. Backtested leak-free at H=13, a dedicated
total model scored between +0.7% and +19.5% against the better of naive and
seasonal-naive depending on the learner, and went NEGATIVE at longer horizons;
the bottom-up sum scored +9.2% to +18.5% and stayed positive for every tree
learner. 31 partly-independent district errors cancel in the sum, and one
series x 183 weeks is simply too thin to learn from on its own. So the total
card is served by summing the district model, at no extra prediction calls.

WHAT IS DELIBERATELY ABSENT: a trend index. A tree cannot extrapolate, so the
row counter for a future week falls outside every split it learned and clamps
at the edge, biasing a rising series low. The level is carried by the lag and
rolling features, which stay inside the range the model has seen.

CONTIGUITY. Every series emits a 0 for a week with no FIRs rather than skipping
it. A skipped week reads as a gap in time and silently mis-aligns every lag
after it.
"""
import csv
import json
import os
from collections import defaultdict
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
FIR = os.path.join(os.path.dirname(HERE), 'fir')
FUNC = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'functions', 'rag')

HORIZON = 13     # weeks the dashboard can forecast (30/60/90 days)
SEASON = 52      # weeks in the seasonal cycle
EPS = 1e-6

# Every feature column, in the order QuickML will see them. This list is the
# CONTRACT with functions/rag/index.js: a prediction whose keys do not match
# the training columns exactly comes back null rather than erroring.
FEATURES = [
    'series', 'horizon', 'month', 'weekofyear', 'quarter',
    'lag_1', 'lag_2', 'lag_3', 'lag_4', 'lag_8', 'lag_13',
    'seasonal_lag_52',
    'roll_mean_4', 'roll_mean_13', 'roll_mean_52', 'roll_std_4',
    'level_ratio_4_52', 'level_ratio_13_52', 'lag1_vs_season', 'cv_4',
]
TARGET = 'target_count'


def read(name):
    with open(os.path.join(FIR, f'{name}.csv'), newline='', encoding='utf-8') as fh:
        return list(csv.DictReader(fh))


def to_date(s):
    return date(int(s[:4]), int(s[5:7]), int(s[8:10]))


def monday(d):
    return d - timedelta(days=d.weekday())


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def pstdev(xs):
    if not xs:
        return 0.0
    m = mean(xs)
    return (sum((x - m) ** 2 for x in xs) / len(xs)) ** 0.5


def build_series(cases, keyfn):
    """{series key: [count per ISO week]} plus the aligned list of week starts.

    The final week is partial (the dataset stops mid-week) and is dropped, so a
    short week is never read as a real decline.
    """
    counts = defaultdict(lambda: defaultdict(int))
    for c in cases:
        k = keyfn(c)
        if k is None:
            continue
        counts[k][monday(to_date(c['CrimeRegisteredDate'][:10]))] += 1

    lo = min(p for s in counts.values() for p in s)
    hi = max(p for s in counts.values() for p in s)
    weeks, p = [], lo
    while p < hi:                      # `<` drops the partial final week
        weeks.append(p)
        p += timedelta(days=7)
    return weeks, {k: [counts[k].get(w, 0) for w in weeks] for k in sorted(counts)}


def feature_row(name, y, t, h, target_week):
    """Features for series `name`, forecasting h weeks past origin t.

    History is y[0..t] inclusive — index t is the last OBSERVED week, so a lag
    of k is y[t-k+1] and lag_1 is the origin itself.
    """
    def lag(k):
        i = t - k + 1
        return float(y[i]) if i >= 0 else 0.0

    def window(n):
        return [float(v) for v in y[max(0, t - n + 1): t + 1]]

    seas_i = t + h - SEASON
    seasonal = float(y[seas_i]) if 0 <= seas_i <= t else lag(1)

    r4, r13, r52 = mean(window(4)), mean(window(13)), mean(window(52))
    s4 = pstdev(window(4))
    iso = target_week.isocalendar()
    return {
        'series': name,
        'horizon': h,
        'month': target_week.month,
        'weekofyear': iso[1],
        'quarter': (target_week.month - 1) // 3 + 1,
        'lag_1': lag(1), 'lag_2': lag(2), 'lag_3': lag(3), 'lag_4': lag(4),
        'lag_8': lag(8), 'lag_13': lag(13),
        'seasonal_lag_52': seasonal,
        'roll_mean_4': round(r4, 4), 'roll_mean_13': round(r13, 4),
        'roll_mean_52': round(r52, 4), 'roll_std_4': round(s4, 4),
        'level_ratio_4_52': round(r4 / (r52 + EPS), 4),
        'level_ratio_13_52': round(r13 / (r52 + EPS), 4),
        'lag1_vs_season': round(lag(1) / (seasonal + EPS), 4),
        'cv_4': round(s4 / (r4 + EPS), 4),
    }


def training_rows(weeks, series):
    """Every (series, origin, horizon) whose target is inside the data.

    Origins start at SEASON so seasonal_lag_52 is a real observation for every
    row — QuickML gets a table with no missing values to guess at.
    """
    rows = []
    n = len(weeks)
    for name, y in series.items():
        for t in range(SEASON, n - 1):
            for h in range(1, HORIZON + 1):
                if t + h >= n:
                    break
                r = feature_row(name, y, t, h, weeks[t + h])
                r[TARGET] = y[t + h]
                rows.append(r)
    return rows


def write_wide(path, weeks, series, prefix):
    cols = ['period_date'] + [f'{prefix}_{k}' for k in series]
    with open(path, 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for i, wk in enumerate(weeks):
            w.writerow([wk.isoformat()] + [series[k][i] for k in series])


def write_train(path, rows):
    with open(path, 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, fieldnames=FEATURES + [TARGET])
        w.writeheader()
        w.writerows(rows)


def naive_mae(weeks, series):
    """The bar. A model that cannot beat the better of these adds nothing."""
    n_err, s_err = [], []
    for y in series.values():
        for t in range(SEASON, len(y) - 1):
            for h in range(1, HORIZON + 1):
                if t + h >= len(y):
                    break
                n_err.append(abs(y[t + h] - y[t]))
                si = t + h - SEASON
                s_err.append(abs(y[t + h] - (y[si] if si >= 0 else y[t])))
    return mean(n_err), mean(s_err)


def main():
    cases = read('CaseMaster')
    units = {u['UnitID']: u for u in read('Unit')}
    print('Forecast tables ->', HERE)

    tables = {}
    specs = (
        ('crimehead', 'crime_major_head', lambda c: c['CrimeMajorHeadID']),
        ('district', 'district',
         lambda c: units.get(c['PoliceStationID'], {}).get('DistrictID') or None),
    )
    for key, prefix, keyfn in specs:
        weeks, series = build_series(cases, keyfn)
        named = {f'{prefix}_{k}': v for k, v in series.items()}
        write_wide(os.path.join(HERE, f'{key}_volume_forecast.csv'), weeks, series, prefix)

        rows = training_rows(weeks, named)
        write_train(os.path.join(HERE, f'{key}_train.csv'), rows)
        nm, sm = naive_mae(weeks, named)
        print(f'  {key + "_train.csv":<24} {len(rows):>6,} rows x {len(FEATURES) + 1} cols  '
              f'{len(named):>2} series  {len(weeks)} weeks   '
              f'baseline MAE naive {nm:.2f} / seasonal {sm:.2f}')

        # The last observed week is the origin every dashboard forecast runs
        # from; its feature rows are fixed, so they are precomputed here rather
        # than recomputed per request.
        t = len(weeks) - 1
        tables[key] = {
            'origin_week': weeks[t].isoformat(),
            'series': sorted(named),
            'horizon': HORIZON,
            'rows': {
                name: [feature_row(name, y, t, h, weeks[t] + timedelta(days=7 * h))
                       for h in range(1, HORIZON + 1)]
                for name, y in named.items()
            },
            # The observed tail, so the UI can draw history against forecast
            # without re-deriving it from the case list.
            'history': {name: y[-SEASON:] for name, y in named.items()},
            'history_weeks': [w.isoformat() for w in weeks[-SEASON:]],
        }

    out = os.path.join(FUNC, 'forecast_features.json')
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump({'features': FEATURES, 'target': TARGET, 'tables': tables}, fh,
                  separators=(',', ':'))
    print(f'  {"forecast_features.json":<24} {os.path.getsize(out) / 1024:>6.0f} KB  -> {FUNC}')
    print('\n  Import the two *_train.csv files as QuickML datasets, one REGRESSION')
    print(f'  pipeline each, target column "{TARGET}".')


if __name__ == '__main__':
    main()
