#!/usr/bin/env python3
"""
Regenerate ksp/fir/Accused.csv with a REALISTIC CRIMINAL-NETWORK structure so the
Crime Links and Case Linkage features have something to analyse. The original
generator gave every accused a fresh random name and a per-case tag (A1, A2), so
nobody recurred and no co-offending existed.

This script keeps the existing CaseMaster.csv (so all foreign keys stay valid)
and only rewrites the accused layer, embedding:
  • a stable population of offenders, each with a GLOBAL id stored in PersonID
    (varchar) — the same person keeps the same id, name, gender across FIRs;
  • repeat offenders (recidivism) — many persons appear in several cases;
  • crews / gangs — groups that co-offend together and reoffend over time,
    producing dense recurring sub-graphs (the "networks" to detect);
  • a few brokers — members who occasionally offend with another crew, bridging
    rings (high betweenness);
  • BEHAVIOURAL CONSISTENCY — a serial offender's (or crew's) cases share the
    same offence sub-head and cluster in space and time, the way real serial
    crime does (Bennell et al., 2014). This is what behavioural case-linkage
    methods detect, so ground-truth linked pairs must actually be linkable.
    Consistency is deliberately imperfect (~15% of series cases break pattern)
    because offenders are not perfectly stable — published linkage AUCs rarely
    exceed 0.90.

Output columns (unchanged): AccusedMasterID, CaseMasterID, AccusedName, AgeYear,
GenderID, PersonID.  PersonID holds the global offender id (e.g. P00473).

Deterministic (seeded). Usage: python3 generate_accused_network.py
"""
import csv
import math
import os
import random
from datetime import datetime

random.seed(1729)
HERE = os.path.dirname(os.path.abspath(__file__))

MALE = ['Manjunath', 'Ravi', 'Suresh', 'Prakash', 'Kiran', 'Harish', 'Santosh', 'Nagaraj',
        'Venkatesh', 'Shivakumar', 'Girish', 'Mahesh', 'Umesh', 'Ramesh', 'Lokesh', 'Praveen',
        'Anand', 'Basavaraj', 'Chandrashekar', 'Dinesh', 'Ganesh', 'Hanumantha', 'Jagadish',
        'Krishna', 'Lakshman', 'Mohan', 'Naveen', 'Puneeth', 'Raghavendra', 'Sandeep',
        'Srinivas', 'Sudeep', 'Vijay', 'Yogesh', 'Arun', 'Bharath', 'Darshan', 'Gopal',
        'Karthik', 'Madhu', 'Nithin', 'Pavan', 'Rajesh', 'Sunil', 'Vinay', 'Abdul', 'Imran',
        'Farhan', 'Salman', 'Irfan', 'Joseph', 'Anthony', 'Wilson', 'Rakesh', 'Shankar']
FEMALE = ['Lakshmi', 'Saraswathi', 'Manjula', 'Sunitha', 'Rekha', 'Geetha', 'Shobha', 'Asha',
          'Kavitha', 'Prema', 'Radha', 'Savitha', 'Uma', 'Vani', 'Bhavya', 'Chaitra', 'Deepa',
          'Divya', 'Gayathri', 'Hema', 'Jyothi', 'Kavya', 'Meena', 'Nandini', 'Pallavi',
          'Rashmi', 'Sahana', 'Shilpa', 'Sowmya', 'Sudha', 'Swathi', 'Veena', 'Vidya',
          'Ayesha', 'Fathima', 'Rukhsana', 'Mary', 'Stella', 'Anitha', 'Pushpa', 'Ratna']
SURNAME = ['Gowda', 'Reddy', 'Shetty', 'Rao', 'Hegde', 'Naik', 'Kumar', 'Murthy', 'Bhat',
           'Patil', 'Kulkarni', 'Desai', 'Poojary', 'Achar', 'Swamy', 'Setty', 'Nayak',
           'Angadi', 'Biradar', 'Chavan', 'Khan', 'Sheikh', 'Syed', 'DSouza', 'Fernandes',
           'Pinto', 'Acharya', 'Joshi', 'Kamath', 'Pai', 'Prabhu', 'Shanbhag']

ALIAS = ['Anna', 'Bhai', 'Chief', 'Chotu', 'Dada', 'Guru', 'Kala', 'Lambu', 'Master',
         'Pandit', 'Raja', 'Seenu', 'Tiger', 'Ustad', 'Boss', 'Chikka', 'Doddi']


def read_cases():
    path = os.path.join(HERE, 'CaseMaster.csv')
    rows = []
    with open(path, newline='') as f:
        for r in csv.DictReader(f):
            d = (r.get('IncidentFromDate') or r.get('CrimeRegisteredDate') or '')[:10]
            try:
                dt = datetime.strptime(d, '%Y-%m-%d')
            except ValueError:
                continue
            rows.append({
                'id': r['CaseMasterID'],
                'date': dt,
                'station': r.get('PoliceStationID') or '',
                'sub': r.get('CrimeMinorHeadID') or '',
                'lat': float(r.get('latitude') or 0),
                'lon': float(r.get('longitude') or 0),
            })
    rows.sort(key=lambda c: c['date'])
    return rows


def km(a, b):
    rad = math.pi / 180
    dla = (b['lat'] - a['lat']) * rad
    dlo = (b['lon'] - a['lon']) * rad
    s = math.sin(dla / 2) ** 2 + math.cos(a['lat'] * rad) * math.cos(b['lat'] * rad) * math.sin(dlo / 2) ** 2
    return 2 * 6371 * math.asin(min(1, math.sqrt(s)))


class Person:
    __slots__ = ('pid', 'name', 'gender', 'base_age', 'first_date', 'cases')

    def __init__(self, pid, gender, name, base_age):
        self.pid = pid
        self.gender = gender
        self.name = name
        self.base_age = base_age
        self.first_date = None
        self.cases = 0


def build_population(n=2600):
    people = []
    used_names = set()
    for i in range(n):
        gender = 1 if random.random() < 0.86 else 2   # accused skew male
        for _ in range(6):
            nm = f'{random.choice(MALE if gender == 1 else FEMALE)} {random.choice(SURNAME)}'
            if nm not in used_names:
                break
        used_names.add(nm)
        if random.random() < 0.18:
            nm = f'{nm} "{random.choice(ALIAS)}"'
        people.append(Person(f'P{i:05d}', gender, nm, random.randint(18, 55)))
    return people


def age_at(p, dt):
    if p.first_date is None:
        p.first_date = dt
    yrs = (dt - p.first_date).days // 365
    return min(75, p.base_age + max(0, yrs))


# ── series building ─────────────────────────────────────────────────────────
# A "series" is a set of cases attributed to the same offender/crew. To mimic
# real serial offending, series members are drawn from the anchor case's
# neighbourhood: same sub-head, within RADIUS_KM and WINDOW_DAYS (with a small
# out-of-pattern fraction so consistency stays realistically imperfect).
RADIUS_KM = 60
WINDOW_DAYS = 365
NOISE = 0.15


def build_series(anchor, pool, want, used):
    """Pick up to `want` cases similar to `anchor` from `pool` (unused only).

    Only genuinely in-pattern cases (same sub-head, close in space and time)
    can form a series; a single out-of-pattern case may then be appended with
    probability NOISE so consistency stays realistically imperfect.
    """
    sims = []
    breakers = []
    for c in pool:
        if c['id'] in used or c is anchor:
            continue
        if (
            c['sub'] == anchor['sub']
            and km(anchor, c) <= RADIUS_KM
            and abs((c['date'] - anchor['date']).days) <= WINDOW_DAYS
        ):
            sims.append((km(anchor, c), c))
        elif len(breakers) < 20:
            breakers.append(c)
    sims.sort(key=lambda t: t[0])
    series = [anchor] + [c for _d, c in sims[:want]]
    if len(series) >= 3 and breakers and random.random() < NOISE:
        series.append(random.choice(breakers))
    return series


def main():
    cases = read_cases()
    people = build_population()
    free_people = list(people)
    random.shuffle(free_people)

    def take_people(n):
        out = []
        for _ in range(n):
            if free_people:
                out.append(free_people.pop())
        return out

    # How many accused each case carries (same distribution as before):
    # 7% none, 55% one, 24% two, 10% three, 4% four.
    k_pop = [k for k, w in [(0, 7), (1, 55), (2, 24), (3, 10), (4, 4)] for _ in range(w)]
    k_by_case = {c['id']: random.choice(k_pop) for c in cases}

    solo_cases = [c for c in cases if k_by_case[c['id']] == 1]
    group_cases = [c for c in cases if k_by_case[c['id']] >= 2]

    rows = []
    acc_id = 0
    used = set()          # case ids already attributed
    crews = []            # list of member lists (for broker wiring + stats)
    crew_series = []      # (crew, series) pairs for the broker pass

    def emit(p, c):
        nonlocal acc_id
        acc_id += 1
        p.cases += 1
        rows.append([acc_id, c['id'], p.name, age_at(p, c['date']), p.gender, p.pid])

    # 1) Crew series — reoffending gangs with a consistent joint MO. Covers
    #    ~60% of multi-accused cases; the rest become one-off group offences.
    random.shuffle(group_cases)
    for anchor in group_cases:
        if anchor['id'] in used or random.random() < 0.4:
            continue
        want = random.choice([1, 2, 2, 3, 3, 4, 5])   # extra cases beyond anchor
        series = build_series(anchor, group_cases, want, used)
        if len(series) < 2:
            continue
        crew = take_people(random.choice([2, 3, 3, 3, 4, 4, 5, 6]))
        if len(crew) < 2:
            break
        crews.append(crew)
        crew_series.append((crew, series))
        for c in series:
            used.add(c['id'])
            k = k_by_case[c['id']]
            members = random.sample(crew, min(k, len(crew)))
            for p in members:
                emit(p, c)

    # 1b) Brokers — a member of one crew guests in another crew's case,
    #     bridging rings (high betweenness) without fusing everything.
    for _ in range(max(1, len(crew_series) // 4)):
        if len(crew_series) < 2:
            break
        (crew_a, _sa), (_cb, series_b) = random.sample(crew_series, 2)
        emit(random.choice(crew_a), random.choice(series_b))

    # 2) Lone serial offenders — consistent personal MO. Covers ~55% of
    #    single-accused cases; the rest are one-off offenders.
    random.shuffle(solo_cases)
    for anchor in solo_cases:
        if anchor['id'] in used or random.random() < 0.45:
            continue
        want = random.choice([1, 1, 2, 2, 3, 4])
        series = build_series(anchor, solo_cases, want, used)
        if len(series) < 2:
            continue
        p = (take_people(1) or [random.choice(people)])[0]
        for c in series:
            used.add(c['id'])
            emit(p, c)

    # 3) Everything else: one-off offenders (fresh people, occasionally an
    #    existing offender straying out of pattern — real-world noise).
    actives = [p for p in people if p.cases > 0]
    for c in cases:
        if c['id'] in used:
            continue
        k = k_by_case[c['id']]
        if k == 0:
            continue
        chosen = []
        for _ in range(k):
            if actives and random.random() < 0.03:
                p = random.choice([q for q in actives if q.cases < 8] or actives)
            else:
                p = (take_people(1) or [random.choice(people)])[0]
            if p in chosen:
                continue
            chosen.append(p)
            emit(p, c)

    rows.sort(key=lambda r: int(r[1]))
    for i, r in enumerate(rows, 1):
        r[0] = i

    out = os.path.join(HERE, 'Accused.csv')
    with open(out, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['AccusedMasterID', 'CaseMasterID', 'AccusedName', 'AgeYear', 'GenderID', 'PersonID'])
        w.writerows(rows)

    # ── sanity stats ────────────────────────────────────────────────────────
    from collections import defaultdict
    pcases = defaultdict(set)
    case_people = defaultdict(list)
    for _id, cm, _nm, _ag, _g, pid in rows:
        pcases[pid].add(cm)
        case_people[cm].append(pid)
    edges = set()
    for cm, ppl in case_people.items():
        for a in range(len(ppl)):
            for b in range(a + 1, len(ppl)):
                edges.add(tuple(sorted((ppl[a], ppl[b]))))
    adj = defaultdict(set)
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    seen, comps = set(), []
    for node in adj:
        if node in seen:
            continue
        stack, comp = [node], []
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            comp.append(x)
            stack.extend(adj[x] - seen)
        comps.append(comp)
    repeat = sum(1 for pid, cs in pcases.items() if len(cs) >= 2)
    comps.sort(key=len, reverse=True)
    print(f'rows                : {len(rows)}')
    print(f'distinct offenders  : {len(pcases)}')
    print(f'repeat offenders    : {repeat} (>=2 cases)')
    print(f'co-offending pairs  : {len(edges)}')
    print(f'linked persons      : {len(adj)}')
    print(f'networks (>=3)      : {sum(1 for c in comps if len(c) >= 3)}')
    print(f'largest network     : {len(comps[0]) if comps else 0} members')


if __name__ == '__main__':
    main()
