#!/usr/bin/env python3
"""Personnel enrichment pass over the FIR dataset (run after generate_fir_dataset.py).

Rewrites two CSVs in place, preserving every EmployeeID/UnitID/DistrictID so
foreign keys elsewhere (CaseMaster.IOID, ArrestSurrender.IOID, …) stay valid:

  Rank.csv     — replaced with the real 12-rank Karnataka ladder
                 (gazetted DGP…DySP + subordinate PI…PC), Hierarchy == RankID.
  Employee.csv — every officer gets a unique "First Last" full name (gender-
                 consistent pools, no two officers share a full name); old
                 RankIDs 5–9 (Inspector…Constable) are remapped to the new
                 8–12; and gazetted officers (IDs 20001+) are appended:
                 state brass at Bengaluru City HQ plus SP / Addl. SP / 2×DySP
                 per district, posted to the District Police Office unit.

Deterministic: fixed RNG seed, so re-running yields identical files.
"""

import csv
import random
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).parent
random.seed(4102)

# ── New rank ladder ──────────────────────────────────────────────────────────
RANKS = [
    (1, 'Director General of Police'),
    (2, 'Additional Director General of Police'),
    (3, 'Inspector General of Police'),
    (4, 'Deputy Inspector General of Police'),
    (5, 'Superintendent of Police'),
    (6, 'Additional Superintendent of Police'),
    (7, 'Deputy Superintendent of Police'),
    (8, 'Police Inspector'),
    (9, 'Police Sub-Inspector'),
    (10, 'Assistant Sub-Inspector'),
    (11, 'Head Constable'),
    (12, 'Police Constable'),
]

# Old Rank.csv ids used by employees → new ladder ids.
RANK_REMAP = {'5': 8, '6': 9, '7': 10, '8': 11, '9': 12}

# ── Name pools (gender-consistent, Karnataka/South-Indian flavour) ──────────
MALE_FIRST = [
    'Aditya', 'Ajay', 'Akash', 'Amit', 'Anand', 'Anil', 'Arjun', 'Arun', 'Ashok',
    'Ashwin', 'Balaji', 'Basavaraj', 'Bharath', 'Chandan', 'Chetan', 'Darshan',
    'Deepak', 'Devraj', 'Dinesh', 'Ganesh', 'Girish', 'Gopal', 'Guru', 'Hari',
    'Harish', 'Hemanth', 'Irfan', 'Jagadish', 'Jayanth', 'Karthik', 'Kiran',
    'Kishore', 'Krishna', 'Kumar', 'Lokesh', 'Madhav', 'Mahadev', 'Mahesh',
    'Manju', 'Manjunath', 'Manoj', 'Mohan', 'Mohammed', 'Murali', 'Nagesh',
    'Nagaraj', 'Nandish', 'Naveen', 'Nikhil', 'Ningappa', 'Nithin', 'Pavan',
    'Prakash', 'Pradeep', 'Prasanna', 'Praveen', 'Prashanth', 'Puneeth',
    'Raghavendra', 'Raghu', 'Rajesh', 'Rajeev', 'Rakesh', 'Ramesh', 'Ranjith',
    'Ravi', 'Ravindra', 'Rohan', 'Rohit', 'Sachin', 'Sandeep', 'Sanjay',
    'Santosh', 'Satish', 'Shankar', 'Sharath', 'Shashank', 'Shivakumar',
    'Shivaraj', 'Shreyas', 'Siddharth', 'Somashekar', 'Srikanth', 'Srinivas',
    'Sudeep', 'Sunil', 'Suresh', 'Syed', 'Tejas', 'Umesh', 'Varun', 'Vasanth',
    'Veeresh', 'Venkatesh', 'Vijay', 'Vikram', 'Vinay', 'Vinod', 'Vishal',
    'Vishwanath', 'Yashwanth', 'Yogesh', 'Abhishek', 'Bhaskar', 'Dhanush',
    'Eshwar', 'Gagan', 'Jeevan', 'Kartik', 'Lohith', 'Madhukar', 'Omkar',
    'Parashuram', 'Raghunandan', 'Sagar', 'Thimmaiah', 'Uday',
]
FEMALE_FIRST = [
    'Aishwarya', 'Akshata', 'Amrutha', 'Ananya', 'Anitha', 'Anjali', 'Anusha',
    'Aparna', 'Archana', 'Asha', 'Bhavana', 'Bhavya', 'Chaitra', 'Chandana',
    'Deepa', 'Deepika', 'Divya', 'Gayathri', 'Geetha', 'Harini', 'Hema',
    'Jyothi', 'Kavana', 'Kavitha', 'Keerthi', 'Lakshmi', 'Lavanya', 'Madhuri',
    'Mamatha', 'Meghana', 'Namratha', 'Nandini', 'Nayana', 'Netravati',
    'Nisha', 'Pallavi', 'Pooja', 'Prathibha', 'Preethi', 'Priya', 'Priyanka',
    'Rachana', 'Ramya', 'Rashmi', 'Rekha', 'Roopa', 'Sahana', 'Sangeetha',
    'Savitha', 'Shalini', 'Shilpa', 'Shobha', 'Shruthi', 'Shwetha', 'Sindhu',
    'Smitha', 'Sneha', 'Soumya', 'Sowmya', 'Spoorthi', 'Sudha', 'Suma',
    'Sushma', 'Swathi', 'Tejaswini', 'Uma', 'Usha', 'Vani', 'Varsha',
    'Veena', 'Vidya', 'Vijayalakshmi', 'Yashoda',
]
SURNAMES = [
    'Achar', 'Angadi', 'Badiger', 'Banakar', 'Belagavi', 'Bhat', 'Bhandari',
    'Biradar', 'Chavan', 'Chikkanna', 'Choudhari', 'Desai', 'Deshpande',
    'Devadiga', 'Dharwad', 'Gaonkar', 'Gouda', 'Gowda', 'Hadimani',
    'Halappa', 'Handral', 'Havaldar', 'Hegde', 'Hiremath', 'Honnappa',
    'Hosamani', 'Hugar', 'Iyengar', 'Iyer', 'Jadhav', 'Jain', 'Javali',
    'Jogi', 'Joshi', 'Kadam', 'Kalburgi', 'Kalmath', 'Kamath', 'Kambar',
    'Kammar', 'Karkera', 'Kattimani', 'Kavery', 'Khan', 'Kharvi', 'Kodagu',
    'Kotian', 'Kulkarni', 'Kumbar', 'Kuruba', 'Lamani', 'Lingayat',
    'Madival', 'Malagi', 'Mallapur', 'Mane', 'Maski', 'Mathad', 'Melkote',
    'Mudhol', 'Mulla', 'Murthy', 'Mysorekar', 'Naik', 'Nadig', 'Nayak',
    'Nekar', 'Padki', 'Pai', 'Patel', 'Patil', 'Pawar', 'Pilar', 'Poojary',
    'Prabhu', 'Pujar', 'Rai', 'Raikar', 'Rao', 'Rathod', 'Reddy', 'Sajjan',
    'Salian', 'Sanadi', 'Sanikop', 'Savant', 'Setty', 'Shanbhag', 'Sharma',
    'Shetty', 'Shirur', 'Sindagi', 'Sirsi', 'Srinivasan', 'Suvarna',
    'Talwar', 'Tavarageri', 'Thakur', 'Ullal', 'Uppar', 'Vaddar', 'Vernekar',
    'Waghmore', 'Yadav', 'Yaligar',
]

used_names = set()


def unique_name(gender_id):
    pool = MALE_FIRST if gender_id == '1' else FEMALE_FIRST
    while True:
        name = f'{random.choice(pool)} {random.choice(SURNAMES)}'
        if name not in used_names:
            used_names.add(name)
            return name


# ── Rank.csv ─────────────────────────────────────────────────────────────────
with open(HERE / 'Rank.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['RankID', 'RankName', 'Hierarchy', 'Active'])
    for rid, rname in RANKS:
        w.writerow([rid, rname, rid, 'true'])

# ── Employee.csv ─────────────────────────────────────────────────────────────
# Enrichment is not idempotent (rank remap, appended rows), so it always reads
# the pristine generator output: Employee.base.csv, snapshotted from
# Employee.csv on first run. After regenerating the dataset, delete the base
# file so a fresh snapshot is taken.
base = HERE / 'Employee.base.csv'
if not base.exists():
    base.write_bytes((HERE / 'Employee.csv').read_bytes())
with open(base, newline='') as f:
    reader = csv.reader(f)
    header = next(reader)
    rows = list(reader)

used_kgids = {r[5] for r in rows}
col = {name: i for i, name in enumerate(header)}

for r in rows:
    r[col['RankID']] = RANK_REMAP[r[col['RankID']]]
    r[col['FirstName']] = unique_name(r[col['GenderID']])

# The base generator can date appointments up to DOB+30y, which lands in the
# future for the youngest officers. Re-roll those into the recent past (joined
# at 20+, within ~6 years of the dataset's "today") so service durations are
# always non-negative. Separate RNG stream so the name draws above stay stable.
clamp_rnd = random.Random(777)
CUTOFF = date(2026, 6, 30)
for r in rows:
    if date.fromisoformat(r[col['AppointmentDate']]) > CUTOFF:
        dob = date.fromisoformat(r[col['EmployeeDOB']])
        earliest = max(dob + timedelta(days=20 * 365), CUTOFF - timedelta(days=6 * 365))
        r[col['AppointmentDate']] = (
            earliest + timedelta(days=clamp_rnd.randint(0, (CUTOFF - earliest).days))
        ).isoformat()

# District Police Office unit (TypeID 4) per district, from Unit.csv.
office_by_district = {}
with open(HERE / 'Unit.csv', newline='') as f:
    for u in csv.DictReader(f):
        if u['TypeID'] == '4':
            office_by_district[u['DistrictID']] = u['UnitID']

districts = sorted(office_by_district)
BLR = '4401'  # state HQ postings sit under the Bengaluru City district office


def new_kgid():
    while True:
        k = f'KGID{random.randint(1000000, 9999999)}'
        if k not in used_kgids:
            used_kgids.add(k)
            return k


def gazetted(eid, district_id, rank_id):
    gender = random.choices(['1', '2'], weights=[85, 15])[0]
    # Senior ranks skew older: DGP ~b.1970, DySP ~b.1984.
    birth_year = 1968 + 2 * rank_id + random.randint(0, 3)
    dob = date(birth_year, 1, 1) + timedelta(days=random.randint(0, 364))
    appt = dob + timedelta(days=random.randint(22 * 365, 26 * 365))
    return [
        eid, district_id, office_by_district[district_id], rank_id,
        6,  # DesignationID (unused for gazetted officers; kept for schema)
        new_kgid(), unique_name(gender), dob.isoformat(), gender,
        random.randint(1, 8),
        'true' if random.random() < 0.02 else 'false',
        appt.isoformat(),
    ]


eid = 20001
# State brass at HQ.
for rank_id, count in [(1, 1), (2, 2), (3, 4), (4, 6)]:
    for _ in range(count):
        rows.append(gazetted(eid, BLR, rank_id))
        eid += 1
# District leadership: SP, Addl. SP and two DySPs each.
for did in districts:
    for rank_id in (5, 6, 7, 7):
        rows.append(gazetted(eid, did, rank_id))
        eid += 1

with open(HERE / 'Employee.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(header)
    w.writerows(rows)

print(f'Rank.csv: {len(RANKS)} ranks | Employee.csv: {len(rows)} officers '
      f'({len(rows) - 744} gazetted added), all names unique: '
      f'{len(used_names) == len(rows)}')
