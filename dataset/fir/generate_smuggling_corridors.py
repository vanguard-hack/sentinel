#!/usr/bin/env python3
"""Derive smuggling / trafficking corridor overlays from the FIR dataset.

There is no authored "corridor" table anywhere in the schema — CCTNS does not
record one, and inventing point-to-point routes by hand would be exactly the
kind of unlabelled fabrication the rest of this dataset avoids. Instead this
script derives corridors the same way Case Linkage and Financial Trails derive
their signal: from case data that is already there.

Method: every CaseMaster row under the Narcotics head (CrimeHeadID 7 — Drug
Peddling / Drug Possession) is attributed to a district via its
PoliceStationID -> Unit -> DistrictID chain. Districts with elevated Narcotics
case density are chained into a route with a nearest-neighbour walk over their
geographic centroids, on the premise that contraband moves between the
districts where it is actually being seized, not along a route nobody
recorded. This is honestly a heuristic, not a mapped trafficking route — the
UI should present it as "elevated narcotics activity corridor", not as
verified ground truth.

Run after dataset/fir/generate_fir_dataset.py (needs CaseMaster.csv, Unit.csv,
District.csv). Not part of the regenerate chain in CLAUDE.md because, like
dataset/geocode_stations.py, its output is a static asset checked into the client
bundle (frontend/public/maps/smuggling-corridors.json) rather than data the
app loads live — re-run it by hand if the underlying case mix changes enough
to be worth refreshing the overlay.

Usage:
    python3 dataset/fir/generate_smuggling_corridors.py
"""

import csv
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'frontend', 'public', 'maps', 'smuggling-corridors.json')

# Same 30 Karnataka district centroids as generate_fir_dataset.py's
# KA_DISTRICTS. Duplicated rather than imported: importing that module would
# re-run its top-level dataset generation as a side effect, and these are
# stable geographic facts, not generated data (CrimeMap.js's own CITY_HOTSPOTS
# duplicates a similar list for the same reason).
KA_DISTRICTS = {
    'Bengaluru City': (12.97, 77.59), 'Bengaluru Rural': (13.28, 77.58),
    'Mysuru': (12.30, 76.65), 'Mandya': (12.52, 76.90), 'Hassan': (13.00, 76.10),
    'Tumakuru': (13.34, 77.10), 'Kolar': (13.14, 78.13),
    'Chikkaballapura': (13.43, 77.73), 'Ramanagara': (12.72, 77.28),
    'Chamarajanagar': (11.92, 76.94), 'Kodagu': (12.42, 75.74),
    'Dakshina Kannada': (12.87, 74.88), 'Udupi': (13.34, 74.75),
    'Uttara Kannada': (14.80, 74.13), 'Shivamogga': (13.93, 75.56),
    'Davanagere': (14.46, 75.92), 'Chitradurga': (14.23, 76.40),
    'Ballari': (15.14, 76.92), 'Vijayanagara': (15.35, 76.46),
    'Koppal': (15.35, 76.15), 'Raichur': (16.21, 77.36),
    'Kalaburagi': (17.33, 76.83), 'Yadgir': (16.77, 77.14),
    'Bidar': (17.91, 77.52), 'Vijayapura': (16.83, 75.71),
    'Bagalkote': (16.18, 75.70), 'Belagavi': (15.85, 74.50),
    'Dharwad': (15.46, 75.01), 'Gadag': (15.43, 75.63),
    'Haveri': (14.79, 75.40), 'Chikkamagaluru': (13.32, 75.77),
}

NDPS_HEAD_ID = '7'
NDPS_SUB = {'701': 'Drug Peddling', '702': 'Drug Possession'}

# How many districts feed the corridor chain, and how many top corridors ship.
TOP_DISTRICTS = 10
MIN_DISTRICTS_PER_CORRIDOR = 2


def read_csv(name):
    with open(os.path.join(HERE, f'{name}.csv'), newline='', encoding='utf-8') as fh:
        return list(csv.DictReader(fh))


def haversine_km(a, b):
    lat1, lon1 = a
    lat2, lon2 = b
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(x))


def main():
    districts = {r['DistrictID']: r['DistrictName'] for r in read_csv('District')}
    unit_district = {r['UnitID']: r['DistrictID'] for r in read_csv('Unit')}

    ndps_by_district = {}     # district name -> total NDPS case count
    ndps_sub_by_district = {}  # district name -> {701: n, 702: n}
    for row in read_csv('CaseMaster'):
        if row['CrimeMajorHeadID'] != NDPS_HEAD_ID:
            continue
        did = unit_district.get(row['PoliceStationID'])
        dname = districts.get(did)
        if dname not in KA_DISTRICTS:
            continue
        ndps_by_district[dname] = ndps_by_district.get(dname, 0) + 1
        sub = row['CrimeMinorHeadID']
        bucket = ndps_sub_by_district.setdefault(dname, {})
        bucket[sub] = bucket.get(sub, 0) + 1

    ranked = sorted(ndps_by_district.items(), key=lambda kv: -kv[1])[:TOP_DISTRICTS]
    if len(ranked) < MIN_DISTRICTS_PER_CORRIDOR:
        print('Not enough Narcotics cases to derive a corridor — skipping.')
        return

    # Nearest-neighbour walk over the top districts' centroids: start at the
    # single highest-density district, always step to the nearest unvisited one.
    # Produces one connected chain rather than disconnected point pairs, which
    # reads as an actual route on the map instead of scattered dots.
    remaining = dict(ranked)
    order = [max(remaining, key=remaining.get)]
    remaining.pop(order[0])
    while remaining:
        last = KA_DISTRICTS[order[-1]]
        nxt = min(remaining, key=lambda d: haversine_km(last, KA_DISTRICTS[d]))
        order.append(nxt)
        remaining.pop(nxt)

    counts = [c for _, c in ranked]
    lo, hi = min(counts), max(counts)
    span = (hi - lo) or 1

    corridors = []
    for i in range(len(order) - 1):
        a, b = order[i], order[i + 1]
        seg_count = ndps_by_district[a] + ndps_by_district[b]
        sub_totals = {'701': 0, '702': 0}
        for d in (a, b):
            for sub, n in ndps_sub_by_district.get(d, {}).items():
                if sub in sub_totals:
                    sub_totals[sub] += n
        label = NDPS_SUB['701' if sub_totals['701'] >= sub_totals['702'] else '702']
        severity = round(
            ((ndps_by_district[a] + ndps_by_district[b]) / 2 - lo) / span, 3
        )
        corridors.append({
            'id': f'corridor-{i + 1}',
            'label': f'{label} corridor',
            'districts': [a, b],
            'waypoints': [list(KA_DISTRICTS[a]), list(KA_DISTRICTS[b])],
            'caseCount': seg_count,
            'severity': max(0.0, min(1.0, severity)),
        })

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(corridors, fh, indent=2)
    print(f'smuggling-corridors.json: {len(corridors)} corridor segments across {len(order)} districts')
    for d in order:
        print(f'  {d}: {ndps_by_district[d]} Narcotics cases')


if __name__ == '__main__':
    main()
