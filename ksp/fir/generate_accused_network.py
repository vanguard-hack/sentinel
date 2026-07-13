#!/usr/bin/env python3
"""
Regenerate ksp/fir/Accused.csv with a REALISTIC CRIMINAL-NETWORK structure so the
Crime Links feature has something to analyse. The original generator gave every
accused a fresh random name and a per-case tag (A1, A2), so nobody recurred and
no co-offending existed.

This script keeps the existing CaseMaster.csv (so all foreign keys stay valid)
and only rewrites the accused layer, embedding:
  • a stable population of offenders, each with a GLOBAL id stored in PersonID
    (varchar) — the same person keeps the same id, name, gender across FIRs;
  • repeat offenders (recidivism) — many persons appear in several cases;
  • crews / gangs — groups that co-offend together and reoffend over time,
    producing dense recurring sub-graphs (the "networks" to detect);
  • a few brokers — members who occasionally offend with another crew, bridging
    rings (high betweenness).

Output columns (unchanged): AccusedMasterID, CaseMasterID, AccusedName, AgeYear,
GenderID, PersonID.  PersonID now holds the global offender id (e.g. P00473).

Deterministic (seeded). Usage: python3 generate_accused_network.py
"""
import csv
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
            d = (r.get('CrimeRegisteredDate') or '')[:10]
            try:
                dt = datetime.strptime(d, '%Y-%m-%d')
            except ValueError:
                continue
            rows.append({
                'id': r['CaseMasterID'],
                'date': dt,
                'station': r.get('PoliceStationID') or '',
            })
    rows.sort(key=lambda c: c['date'])
    return rows


class Person:
    __slots__ = ('pid', 'name', 'gender', 'base_age', 'station', 'crew',
                 'first_date', 'cases')

    def __init__(self, pid, gender, name, base_age, station):
        self.pid = pid
        self.gender = gender
        self.name = name
        self.base_age = base_age
        self.station = station
        self.crew = None
        self.first_date = None
        self.cases = 0


def build_population(stations):
    people = []
    used_names = set()
    n = 1000
    for i in range(n):
        gender = 1 if random.random() < 0.86 else 2   # accused skew male
        # keep names mostly unique so identities read as distinct real people
        for _ in range(6):
            nm = f'{random.choice(MALE if gender == 1 else FEMALE)} {random.choice(SURNAME)}'
            if nm not in used_names:
                break
        used_names.add(nm)
        # a minority carry a street alias (they tend to be the networked ones)
        if random.random() < 0.18:
            nm = f'{nm} "{random.choice(ALIAS)}"'
        people.append(Person(f'P{i:05d}', gender, nm, random.randint(18, 55),
                             random.choice(stations)))
    return people


def build_crews(people):
    """Group ~55% of persons into crews of 2–6, biased to a shared home station."""
    by_station = {}
    for p in people:
        by_station.setdefault(p.station, []).append(p)
    crews = []
    pool = [p for p in people if random.random() < 0.55]
    random.shuffle(pool)
    i = 0
    cid = 0
    while i < len(pool):
        size = random.choice([2, 2, 3, 3, 3, 4, 4, 5, 6])
        anchor = pool[i]
        members = [anchor]
        # prefer crew-mates from the anchor's station for geographic coherence
        locals_ = [p for p in by_station.get(anchor.station, [])
                   if p is not anchor and p.crew is None]
        random.shuffle(locals_)
        for p in locals_:
            if len(members) >= size:
                break
            members.append(p)
        j = i + 1
        while len(members) < size and j < len(pool):
            if pool[j].crew is None and pool[j] not in members:
                members.append(pool[j])
            j += 1
        if len(members) >= 2:
            for p in members:
                p.crew = cid
            crews.append(members)
            cid += 1
        i += max(1, len(members))
    return crews


def age_at(p, dt):
    if p.first_date is None:
        p.first_date = dt
    yrs = (dt - p.first_date).days // 365
    return min(75, p.base_age + max(0, yrs))


def main():
    cases = read_cases()
    stations = sorted({c['station'] for c in cases if c['station']}) or ['0']
    people = build_population(stations)
    crews = build_crews(people)

    by_station_crews = {}
    for idx, members in enumerate(crews):
        st = members[0].station
        by_station_crews.setdefault(st, []).append(idx)

    active = []          # persons who already have >=1 case (recidivism pool)
    active_crews = []    # crews that have offended (reoffend together)
    rows = []
    acc_id = 0

    K_WEIGHTS = [(0, 7), (1, 55), (2, 24), (3, 10), (4, 4)]
    k_pop = [k for k, w in K_WEIGHTS for _ in range(w)]

    def fresh_person(station):
        cands = [p for p in people if p.cases == 0]
        if not cands:
            return random.choice(people)
        local = [p for p in cands if p.station == station]
        return random.choice(local if local and random.random() < 0.6 else cands)

    def repeat_person(station, avoid):
        cands = [p for p in active if p.cases < 8 and p not in avoid]
        if not cands:
            return fresh_person(station)
        local = [p for p in cands if p.station == station]
        return random.choice(local if local and random.random() < 0.5 else cands)

    def pick_crew(station):
        # reoffending crews recur; otherwise a station-local crew, else any crew
        if active_crews and random.random() < 0.5:
            return random.choice(active_crews)
        here = by_station_crews.get(station)
        if here and random.random() < 0.7:
            return random.choice(here)
        return random.randrange(len(crews)) if crews else None

    def use(p, dt):
        if p.cases == 0:
            active.append(p)
        p.cases += 1
        return {'pid': p.pid, 'name': p.name, 'gender': p.gender, 'age': age_at(p, dt)}

    for c in cases:
        k = random.choice(k_pop)
        if k == 0:
            continue
        dt, station = c['date'], c['station']
        chosen = []
        picked = set()

        if k >= 2 and crews and random.random() < 0.9:
            ci = pick_crew(station)
            if ci is not None:
                crew = crews[ci]
                take = min(k, len(crew), random.randint(2, max(2, len(crew))))
                for p in random.sample(crew, take):
                    chosen.append(use(p, dt)); picked.add(p)
                if ci not in active_crews:
                    active_crews.append(ci)
                # rare broker from another crew — a deliberate bridge between
                # rings (high betweenness), kept scarce so rings stay distinct
                if len(chosen) < k and random.random() < 0.03:
                    b = repeat_person(station, picked)
                    chosen.append(use(b, dt)); picked.add(b)
                # any remaining slots: station-local first-timers join this crew
                while len(chosen) < k:
                    p = fresh_person(station)
                    if p in picked:
                        break
                    chosen.append(use(p, dt)); picked.add(p)

        # single-accused, or no crew available: keep links station-local so
        # arbitrary cross-station pairs don't fuse every ring into one blob.
        while len(chosen) < k:
            if k == 1 and active and random.random() < 0.55:
                p = repeat_person(station, picked)   # lone repeat offender
            else:
                locals_active = [q for q in active
                                 if q.station == station and q.cases < 8 and q not in picked]
                if locals_active and random.random() < 0.3:
                    p = random.choice(locals_active)
                else:
                    p = fresh_person(station)
            if p in picked:
                if len(picked) >= len(people):
                    break
                continue
            chosen.append(use(p, dt)); picked.add(p)

        for person_row in chosen:
            acc_id += 1
            rows.append([acc_id, c['id'], person_row['name'], person_row['age'],
                         person_row['gender'], person_row['pid']])

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
    # connected components over the co-offending graph
    adj = defaultdict(set)
    for a, b in edges:
        adj[a].add(b); adj[b].add(a)
    seen, comps = set(), []
    for node in adj:
        if node in seen:
            continue
        stack, comp = [node], []
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x); comp.append(x)
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
