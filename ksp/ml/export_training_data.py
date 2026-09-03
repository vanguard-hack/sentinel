#!/usr/bin/env python3
"""
Flatten the 26-table FIR schema into the training tables QuickML imports.

QuickML takes one flat CSV per model, picks the target column, and runs its own
feature engineering. So the work here is the join, the feature construction and
— most importantly — deciding what a model is ALLOWED to see.

Three outputs, one per model:

  chargesheet_outcome.csv   classification   will this FIR reach a chargesheet?
  crime_head.csv            classification   what kind of offence is this?
  disposal_lag.csv          regression       how many days to the chargesheet?

TWO RULES DECIDE WHICH COLUMNS EXIST
────────────────────────────────────

1. No feature may be unavailable at prediction time.

   CaseStatusID is the obvious trap. Chargesheet is a deterministic function of
   it, so including it would score ~99% and mean nothing: the status is the
   outcome restated, and it does not exist when an FIR is first registered.
   Anything derived from the chargesheet itself is excluded for the same
   reason. This is the difference between a model and a lookup.

2. No protected attribute is ever a feature.

   Religion, caste and gender are in the schema because CCTNS records them.
   They are excluded here for every model, deliberately and permanently — a
   police system that learns "this community's cases get charged less" would
   then act on it. utils/predict.js states the same rule for the client-side
   analytics; this is the training-side half of it.

   Victim and accused AGE is kept: it is a case attribute rather than a
   protected class, and it carries real signal for offence type.
"""
import collections
import csv
import os
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
FIR = os.path.join(os.path.dirname(HERE), 'fir')
OUT = HERE
TODAY = date(2026, 7, 1)


def read(name):
    with open(os.path.join(FIR, f'{name}.csv'), newline='', encoding='utf-8') as fh:
        return list(csv.DictReader(fh))


def d(s):
    y, m, dd = map(int, s[:10].split('-'))
    return date(y, m, dd)


def build():
    cases = read('CaseMaster')
    chargesheets = {r['CaseMasterID']: r for r in read('ChargesheetDetails')}
    accused = collections.Counter(r['CaseMasterID'] for r in read('Accused'))
    acc_age = collections.defaultdict(list)
    for r in read('Accused'):
        if r['AgeYear']:
            acc_age[r['CaseMasterID']].append(int(r['AgeYear']))
    victims = collections.Counter(r['CaseMasterID'] for r in read('Victim'))
    vic_age = collections.defaultdict(list)
    for r in read('Victim'):
        if r['AgeYear']:
            vic_age[r['CaseMasterID']].append(int(r['AgeYear']))
    arrests = collections.Counter(r['CaseMasterID'] for r in read('ArrestSurrender'))
    complainants = collections.Counter(r['CaseMasterID'] for r in read('ComplainantDetails'))
    units = {u['UnitID']: u for u in read('Unit')}

    # Station and officer workload, computed from the cases themselves. A busy
    # station is a real driver of whether a case is charged, and it is knowable
    # at registration time, so it is a legitimate feature.
    ps_total = collections.Counter(c['PoliceStationID'] for c in cases)
    io_total = collections.Counter(c['PolicePersonID'] for c in cases)

    rows = []
    for c in cases:
        cid = c['CaseMasterID']
        reg = d(c['CrimeRegisteredDate'])
        inc = c['IncidentFromDate']
        hour = int(inc[11:13]) if len(inc) >= 13 else 0
        cs = chargesheets.get(cid)
        lag = (d(cs['csdate']) - reg).days if cs else ''
        rows.append({
            # ── identity, dropped before training, kept for joins ──
            'case_id': cid,
            # ── features: all knowable the day the FIR is registered ──
            'crime_major_head': c['CrimeMajorHeadID'],
            'crime_minor_head': c['CrimeMinorHeadID'],
            'case_category': c['CaseCategoryID'],
            'gravity': c['GravityOffenceID'],
            'police_station': c['PoliceStationID'],
            'district': units.get(c['PoliceStationID'], {}).get('DistrictID', ''),
            'incident_hour': hour,
            'incident_weekday': reg.weekday(),
            'reg_month': reg.month,
            'reg_year': reg.year,
            'report_delay_days': max(0, (reg - d(inc)).days),
            'n_accused': accused.get(cid, 0),
            'n_victims': victims.get(cid, 0),
            'n_complainants': complainants.get(cid, 0),
            'n_arrests': arrests.get(cid, 0),
            'arrest_made': 1 if arrests.get(cid, 0) else 0,
            'accused_age_mean': round(sum(acc_age[cid]) / len(acc_age[cid]), 1) if acc_age[cid] else '',
            'victim_age_mean': round(sum(vic_age[cid]) / len(vic_age[cid]), 1) if vic_age[cid] else '',
            'station_caseload': ps_total[c['PoliceStationID']],
            'io_caseload': io_total[c['PolicePersonID']],
            'case_age_days': (TODAY - reg).days,
            # ── targets ──
            'chargesheeted': 1 if cs else 0,
            'disposal_lag_days': lag,
        })
    return rows


FEATURES = ['crime_major_head', 'crime_minor_head', 'case_category', 'gravity',
            'police_station', 'district', 'incident_hour', 'incident_weekday',
            'reg_month', 'reg_year', 'report_delay_days', 'n_accused', 'n_victims',
            'n_complainants', 'n_arrests', 'arrest_made', 'accused_age_mean',
            'victim_age_mean', 'station_caseload', 'io_caseload', 'case_age_days']


def write(name, cols, rows):
    path = os.path.join(OUT, name)
    with open(path, 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)
    print(f'  {name:<26} {len(rows):>6} rows x {len(cols)} cols')


def main():
    rows = build()

    # 1. Chargesheet outcome — every case.
    write('chargesheet_outcome.csv', FEATURES + ['chargesheeted'], rows)

    # 2. Crime head — the head is the target, so it and its sub-head come out
    #    of the feature list. Everything else about the incident stays.
    head_feats = [f for f in FEATURES if f not in ('crime_major_head', 'crime_minor_head', 'gravity')]
    write('crime_head.csv', head_feats + ['crime_major_head'],
          [dict(r, crime_major_head=r['crime_major_head']) for r in rows])

    # 3. Disposal lag — only cases that actually reached a chargesheet have a
    #    lag to learn. case_age_days is dropped: for a charged case it bounds
    #    the answer from above, which is leakage.
    lag_feats = [f for f in FEATURES if f != 'case_age_days']
    charged = [r for r in rows if r['disposal_lag_days'] != '']
    write('disposal_lag.csv', lag_feats + ['disposal_lag_days'], charged)


if __name__ == '__main__':
    print('Training tables ->', OUT)
    main()
