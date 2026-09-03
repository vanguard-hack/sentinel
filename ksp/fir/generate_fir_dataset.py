#!/usr/bin/env python3
"""
Synthetic Karnataka Police FIR dataset generator (per Police_FIR_ER_Diagram.pdf).

Generates every table in the ERD as a CSV in ksp/fir/, with consistent foreign
keys, realistic Karnataka geography, and CrimeNo built to the documented format:
  1-digit CaseCategory code + 4-digit DistrictID + 4-digit UnitID + 4-digit year
  + 5-digit per-(station, category, year) running serial.
CaseNo is the last 9 digits (YYYY + serial).

Deterministic: seeded RNG, no external dependencies (no faker needed).
Volumes stay under the Catalyst dev-environment 5,000-row bulk-import cap.

Usage: python3 generate_fir_dataset.py
"""
import csv
import os
import math
import random
from datetime import date, datetime, timedelta

random.seed(42)
OUT = os.path.dirname(os.path.abspath(__file__))

# ── name pools (Karnataka / South-Indian) ───────────────────────────────────
MALE = ['Manjunath','Ravi','Suresh','Prakash','Kiran','Harish','Santosh','Nagaraj',
        'Venkatesh','Shivakumar','Girish','Mahesh','Umesh','Ramesh','Lokesh','Praveen',
        'Anand','Basavaraj','Chandrashekar','Dinesh','Ganesh','Hanumantha','Jagadish',
        'Krishna','Lakshman','Mohan','Naveen','Puneeth','Raghavendra','Sandeep',
        'Srinivas','Sudeep','Vijay','Yogesh','Arun','Bharath','Darshan','Gopal',
        'Karthik','Madhu','Nithin','Pavan','Rajesh','Sunil','Vinay','Abdul','Imran',
        'Farhan','Salman','Irfan','Joseph','Anthony','Wilson','Rakesh','Shankar']
FEMALE = ['Lakshmi','Saraswathi','Manjula','Sunitha','Rekha','Geetha','Shobha','Asha',
          'Kavitha','Prema','Radha','Savitha','Uma','Vani','Bhavya','Chaitra','Deepa',
          'Divya','Gayathri','Hema','Jyothi','Kavya','Meena','Nandini','Pallavi',
          'Rashmi','Sahana','Shilpa','Sowmya','Sudha','Swathi','Veena','Vidya',
          'Ayesha','Fathima','Rukhsana','Mary','Stella','Anitha','Pushpa','Ratna']
SURNAME = ['Gowda','Reddy','Shetty','Rao','Hegde','Naik','Kumar','Murthy','Bhat',
           'Patil','Kulkarni','Desai','Poojary','Achar','Swamy','Setty','Nayak',
           'Angadi','Biradar','Chavan','Khan','Sheikh','Syed','DSouza','Fernandes',
           'Pinto','Acharya','Joshi','Kamath','Pai','Prabhu','Shanbhag']

def person(gender):
    first = random.choice(MALE if gender == 1 else FEMALE)
    return f'{first} {random.choice(SURNAME)}'

# ── geography ────────────────────────────────────────────────────────────────
# DistrictID is 4-digit because CrimeNo embeds it directly.
KA_DISTRICTS = [
    ('Bengaluru City', 12.97, 77.59), ('Bengaluru Rural', 13.28, 77.58),
    ('Mysuru', 12.30, 76.65), ('Mandya', 12.52, 76.90), ('Hassan', 13.00, 76.10),
    ('Tumakuru', 13.34, 77.10), ('Kolar', 13.14, 78.13),
    ('Chikkaballapura', 13.43, 77.73), ('Ramanagara', 12.72, 77.28),
    ('Chamarajanagar', 11.92, 76.94), ('Kodagu', 12.42, 75.74),
    ('Dakshina Kannada', 12.87, 74.88), ('Udupi', 13.34, 74.75),
    ('Uttara Kannada', 14.80, 74.13), ('Shivamogga', 13.93, 75.56),
    ('Davanagere', 14.46, 75.92), ('Chitradurga', 14.23, 76.40),
    ('Ballari', 15.14, 76.92), ('Vijayanagara', 15.35, 76.46),
    ('Koppal', 15.35, 76.15), ('Raichur', 16.21, 77.36),
    ('Kalaburagi', 17.33, 76.83), ('Yadgir', 16.77, 77.14),
    ('Bidar', 17.91, 77.52), ('Vijayapura', 16.83, 75.71),
    ('Bagalkote', 16.18, 75.70), ('Belagavi', 15.85, 74.50),
    ('Dharwad', 15.46, 75.01), ('Gadag', 15.43, 75.63),
    ('Haveri', 14.79, 75.40), ('Chikkamagaluru', 13.32, 75.77),
]
STATES = [(1, 'Karnataka'), (2, 'Maharashtra'), (3, 'Tamil Nadu'),
          (4, 'Andhra Pradesh'), (5, 'Kerala'), (6, 'Telangana'), (7, 'Goa')]
OTHER_DISTRICTS = [(5101, 'Pune', 2), (5102, 'Kolhapur', 2), (5201, 'Chennai', 3),
                   (5202, 'Krishnagiri', 3), (5301, 'Anantapur', 4),
                   (5401, 'Kasaragod', 5), (5501, 'Hyderabad', 6), (5601, 'South Goa', 7)]

# ── writers ──────────────────────────────────────────────────────────────────
def write(name, header, rows):
    with open(os.path.join(OUT, f'{name}.csv'), 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(rows)
    print(f'{name}: {len(rows)} rows')

# ── master tables ────────────────────────────────────────────────────────────
write('State', ['StateID', 'StateName', 'NationalityID', 'Active'],
      [[sid, n, 1, 'true'] for sid, n in STATES])

districts = [(4401 + i, name, 1, lat, lon) for i, (name, lat, lon) in enumerate(KA_DISTRICTS)]
write('District', ['DistrictID', 'DistrictName', 'StateID', 'Active'],
      [[d, n, s, 'true'] for d, n, s, _, _ in districts] +
      [[d, n, s, 'true'] for d, n, s in OTHER_DISTRICTS])
DIST_GEO = {d: (lat, lon) for d, _, _, lat, lon in districts}

unit_types = [(1, 'Police Station', 'City', 5), (2, 'Circle Office', 'City', 4),
              (3, 'Sub-Division', 'District', 3), (4, 'District Police Office', 'District', 2),
              (5, 'Commissionerate', 'City', 2), (6, 'Range Office', 'State', 1)]
write('UnitType', ['UnitTypeID', 'UnitTypeName', 'CityDistState', 'Hierarchy', 'Active'],
      [[i, n, c, h, 'true'] for i, n, c, h in unit_types])

# Police stations: 4 per district + one DPO parent per district.
units, PS_BY_DIST = [], {}
uid = 1001
PS_NAMES = ['Town', 'Rural', 'Traffic', 'Women', 'Market', 'Extension', 'East', 'West']
for did, dname, _, _, _ in districts:
    dpo = uid
    units.append([dpo, f'{dname} District Police Office', 4, '', 1, 1, did, 'true'])
    uid += 1
    PS_BY_DIST[did] = []
    for suffix in random.sample(PS_NAMES, 4):
        units.append([uid, f'{dname} {suffix} Police Station', 1, dpo, 1, 1, did, 'true'])
        PS_BY_DIST[did].append(uid)
        uid += 1
write('Unit', ['UnitID', 'UnitName', 'TypeID', 'ParentUnit', 'NationalityID',
               'StateID', 'DistrictID', 'Active'], units)
ALL_PS = [u for lst in PS_BY_DIST.values() for u in lst]
PS_DISTRICT = {u[0]: u[6] for u in units if u[2] == 1}
# DistrictID -> name, for the reserved no-data combination.
DISTRICTS_BY_ID = {d[0]: d[1] for d in districts}

# ── How much crime each district carries ─────────────────────────────────────
# Cases used to be spread UNIFORMLY over every station, and that quietly broke
# each district-level model. Measured across the 31 districts, the spread in
# annual volume was SMALLER than Poisson noise alone would produce (sd 14.6
# observed against 17.0 expected if every district were identical): the
# districts were not merely similar, they were the same series drawn 31 times.
# A district forecaster had nothing to find, and the risk board was ranking
# sampling noise.
#
# These are relative crime volumes, following population and how urban each
# district is — Bengaluru City alone carries roughly a fifth of the state's
# registered crime, while Kodagu is a rounding error beside it. The spread is
# about 14:1, which is both realistic and comfortably learnable.
DISTRICT_CRIME_WEIGHT = {
    'Bengaluru City': 100, 'Belagavi': 30, 'Mysuru': 28, 'Kalaburagi': 24,
    'Tumakuru': 22, 'Dakshina Kannada': 22, 'Dharwad': 20, 'Ballari': 20,
    'Vijayapura': 19, 'Shivamogga': 18, 'Bengaluru Rural': 16, 'Mandya': 16,
    'Hassan': 16, 'Raichur': 15, 'Bagalkote': 15, 'Davanagere': 15,
    'Bidar': 14, 'Kolar': 13, 'Haveri': 13, 'Chitradurga': 13, 'Koppal': 12,
    'Chikkamagaluru': 11, 'Udupi': 11, 'Uttara Kannada': 11, 'Ramanagara': 10,
    'Chikkaballapura': 10, 'Vijayanagara': 10, 'Gadag': 9, 'Yadgir': 9,
    'Chamarajanagar': 9, 'Kodagu': 7,
}
assert set(DISTRICT_CRIME_WEIGHT) == set(DISTRICTS_BY_ID.values()), \
    'DISTRICT_CRIME_WEIGHT must name every Karnataka district exactly once'

# A station inherits its district's weight; each district has the same number
# of stations, so this spreads the district total evenly inside it.
PS_WEIGHTS = [DISTRICT_CRIME_WEIGHT[DISTRICTS_BY_ID[PS_DISTRICT[u]]] for u in ALL_PS]

# Drawn from a SEPARATE stream, deliberately. Weighting the station changes how
# many random numbers the draw consumes, which would shift every field after it
# — crime head, hour, dates — and silently invalidate models already trained on
# them. Its own Random keeps this change confined to WHERE a case happened.
PS_RNG = random.Random(43)

ranks = [(1, 'Director General of Police', 1), (2, 'Inspector General of Police', 2),
         (3, 'Superintendent of Police', 3), (4, 'Deputy SP', 4), (5, 'Inspector', 5),
         (6, 'Police Sub-Inspector', 6), (7, 'Assistant Sub-Inspector', 7),
         (8, 'Head Constable', 8), (9, 'Police Constable', 9)]
write('Rank', ['RankID', 'RankName', 'Hierarchy', 'Active'],
      [[i, n, h, 'true'] for i, n, h in ranks])

designations = [(1, 'Station House Officer', 1), (2, 'Investigating Officer', 2),
                (3, 'Station Writer', 3), (4, 'Beat Officer', 4),
                (5, 'Circle Inspector', 5), (6, 'District Superintendent', 6)]
write('Designation', ['DesignationID', 'DesignationName', 'Active', 'SortOrder'],
      [[i, n, 'true', s] for i, n, s in designations])

# Employees: a station roster.
#
# Six per station was enough to give every case an IO and no more. A real
# Karnataka station carries thirty to sixty, and the thin roster showed: the
# Action Queue's by-officer view had a handful of names each holding an
# implausible share of the district's work. STAFF_PER_PS scales it; the ranks
# below repeat in order, so the shape of the roster (one SHO, several IOs, a
# tail of constables) is preserved at any size.
STAFF_PER_PS = int(os.environ.get('STAFF_PER_PS', '6'))
ROSTER = [(5, 1), (6, 2), (6, 2), (7, 3), (8, 4), (9, 4)]

employees, EMP_BY_PS, eid = [], {}, 10001
for ps in ALL_PS:
    did = PS_DISTRICT[ps]
    EMP_BY_PS[ps] = []
    for slot in range(STAFF_PER_PS):
        # The first slot is always the SHO; the rest cycle through the tail, so
        # a bigger roster adds investigators and constables, not more SHOs.
        rank_id, desig = ROSTER[0] if slot == 0 else ROSTER[1 + (slot - 1) % (len(ROSTER) - 1)]
        g = random.choices([1, 2], weights=[80, 20])[0]
        dob = date(1968, 1, 1) + timedelta(days=random.randint(0, 12000))
        appt = dob + timedelta(days=random.randint(21 * 365, 30 * 365))
        employees.append([eid, did, ps, rank_id, desig, f'KGID{random.randint(1000000, 9999999)}',
                          person(g).split()[0], dob.isoformat(), g, random.randint(1, 8),
                          'true' if random.random() < 0.02 else 'false', appt.isoformat()])
        if rank_id in (5, 6):
            EMP_BY_PS[ps].append(eid)
        eid += 1
# Written twice on purpose. Employee.csv is the working file that
# enrich_personnel.py rewrites in place; Employee.base.csv is the pristine
# generator output it reads FROM. The base used to be snapshotted by the
# enrichment on first run, which meant a regenerated dataset silently kept the
# old roster until someone remembered to delete it — and an attempt to detect
# that by comparing row counts was worse, because enrichment appends gazetted
# officers and so always changes the count: the second run then treated its own
# output as pristine and remapped every rank twice.
write('Employee', ['EmployeeID', 'DistrictID', 'UnitID', 'RankID', 'DesignationID',
                   'KGID', 'FirstName', 'EmployeeDOB', 'GenderID', 'BloodGroupID',
                   'PhysicallyChallenged', 'AppointmentDate'], employees)

write('Employee.base', ['EmployeeID', 'DistrictID', 'UnitID', 'RankID', 'DesignationID',
                        'KGID', 'FirstName', 'EmployeeDOB', 'GenderID', 'BloodGroupID',
                        'PhysicallyChallenged', 'AppointmentDate'], employees)
# Courts: District & Sessions + JMFC per district.
courts, COURT_BY_DIST, cid = [], {}, 601
for did, dname, _, _, _ in districts:
    COURT_BY_DIST[did] = []
    for cname in (f'{dname} District & Sessions Court', f'JMFC Court {dname}'):
        courts.append([cid, cname, did, 1, 'true'])
        COURT_BY_DIST[did].append(cid)
        cid += 1
write('Court', ['CourtID', 'CourtName', 'DistrictID', 'StateID', 'Active'], courts)

write('CaseCategory', ['CaseCategoryID', 'LookupValue'],
      [[1, 'FIR'], [3, 'UDR'], [4, 'PAR'], [8, 'Zero FIR']])
write('GravityOffence', ['GravityOffenceID', 'LookupValue'],
      [[1, 'Heinous'], [2, 'Non-Heinous']])
statuses = [(1, 'Under Investigation'), (2, 'Charge Sheeted'), (3, 'Pending Trial'),
            (4, 'Convicted'), (5, 'Acquitted'), (6, 'Closed - False Case'),
            (7, 'Closed - Undetected')]
write('CaseStatusMaster', ['CaseStatusID', 'CaseStatusName'], [[i, n] for i, n in statuses])
write('ReligionMaster', ['ReligionID', 'ReligionName'],
      [[i + 1, n] for i, n in enumerate(['Hindu', 'Muslim', 'Christian', 'Jain',
                                         'Sikh', 'Buddhist', 'Others'])])
write('CasteMaster', ['caste_master_id', 'caste_master_name'],
      [[i + 1, n] for i, n in enumerate(['General', 'OBC', 'SC', 'ST', 'Category-1',
                                         'Category-2A', 'Category-2B', 'Category-3A',
                                         'Category-3B', 'Not Stated'])])
occupations = ['Farmer', 'Student', 'Government Employee', 'Private Employee',
               'Business', 'Driver', 'Homemaker', 'Daily Wage Worker', 'Retired',
               'Unemployed', 'Teacher', 'Doctor', 'Engineer', 'Police Personnel']
write('OccupationMaster', ['OccupationID', 'OccupationName'],
      [[i + 1, n] for i, n in enumerate(occupations)])

acts = [('IPC', 'Indian Penal Code, 1860', 'IPC'),
        ('BNS', 'Bharatiya Nyaya Sanhita, 2023', 'BNS'),
        ('NDPS', 'Narcotic Drugs and Psychotropic Substances Act, 1985', 'NDPS Act'),
        ('ARMS', 'Arms Act, 1959', 'Arms Act'),
        ('IT', 'Information Technology Act, 2000', 'IT Act'),
        ('POCSO', 'Protection of Children from Sexual Offences Act, 2012', 'POCSO'),
        ('MV', 'Motor Vehicles Act, 1988', 'MV Act'),
        ('EXCISE', 'Karnataka Excise Act, 1965', 'Excise Act'),
        ('DP', 'Dowry Prohibition Act, 1961', 'DP Act'),
        ('KPA', 'Karnataka Police Act, 1963', 'KP Act')]
write('Act', ['ActCode', 'ActDescription', 'ShortName', 'Active'],
      [[c, d, s, 'true'] for c, d, s in acts])

sections = [
    ('IPC', '302', 'Murder'), ('IPC', '307', 'Attempt to murder'),
    ('IPC', '304A', 'Death by negligence'), ('IPC', '323', 'Voluntarily causing hurt'),
    ('IPC', '324', 'Hurt by dangerous weapons'), ('IPC', '341', 'Wrongful restraint'),
    ('IPC', '354', 'Assault on woman with intent to outrage modesty'),
    ('IPC', '363', 'Kidnapping'), ('IPC', '376', 'Rape'),
    ('IPC', '379', 'Theft'), ('IPC', '380', 'Theft in dwelling house'),
    ('IPC', '392', 'Robbery'), ('IPC', '395', 'Dacoity'),
    ('IPC', '406', 'Criminal breach of trust'), ('IPC', '420', 'Cheating'),
    ('IPC', '498A', 'Cruelty by husband or relatives'),
    ('IPC', '506', 'Criminal intimidation'), ('IPC', '509', 'Insult to modesty of woman'),
    ('IPC', '147', 'Rioting'), ('IPC', '279', 'Rash driving on public way'),
    ('NDPS', '20', 'Possession of cannabis'), ('NDPS', '21', 'Possession of manufactured drugs'),
    ('NDPS', '22', 'Possession of psychotropic substances'),
    ('ARMS', '25', 'Possession of illegal arms'),
    ('IT', '66', 'Computer-related offences'), ('IT', '66C', 'Identity theft'),
    ('IT', '66D', 'Cheating by personation using computer'), ('IT', '67', 'Obscene material online'),
    ('POCSO', '4', 'Penetrative sexual assault'), ('POCSO', '8', 'Sexual assault'),
    ('MV', '184', 'Dangerous driving'), ('EXCISE', '32', 'Illegal sale of liquor'),
    ('DP', '3', 'Taking dowry'), ('DP', '4', 'Demanding dowry'),
    ('KPA', '87', 'Gambling in public place'),
]
write('Section', ['ActCode', 'SectionCode', 'SectionDescription', 'Active'],
      [[a, s, d, 'true'] for a, s, d in sections])

crime_heads = [(1, 'Crimes Against Body'), (2, 'Crimes Against Property'),
               (3, 'Crimes Against Women'), (4, 'Crimes Against Children'),
               (5, 'Economic Offences'), (6, 'Cyber Crimes'), (7, 'Narcotics'),
               (8, 'Public Order'), (9, 'Traffic Offences'), (10, 'Other Offences')]
write('CrimeHead', ['CrimeHeadID', 'CrimeGroupName', 'Active'],
      [[i, n, 'true'] for i, n in crime_heads])

sub_heads = [
    (101, 1, 'Murder'), (102, 1, 'Attempt to Murder'), (103, 1, 'Grievous Hurt'),
    (104, 1, 'Kidnapping'), (105, 1, 'Unnatural Death'),
    (201, 2, 'Theft'), (202, 2, 'House Burglary'), (203, 2, 'Robbery'),
    (204, 2, 'Dacoity'), (205, 2, 'Vehicle Theft'), (206, 2, 'Chain Snatching'),
    (301, 3, 'Rape'), (302, 3, 'Molestation'), (303, 3, 'Dowry Harassment'),
    (304, 3, 'Eve Teasing'),
    (401, 4, 'Child Sexual Assault'), (402, 4, 'Child Kidnapping'),
    (501, 5, 'Cheating'), (502, 5, 'Criminal Breach of Trust'),
    (601, 6, 'Online Financial Fraud'), (602, 6, 'Identity Theft'),
    (603, 6, 'Cyber Obscenity'),
    (701, 7, 'Drug Peddling'), (702, 7, 'Drug Possession'),
    (801, 8, 'Rioting'), (802, 8, 'Illegal Gambling'), (803, 8, 'Illicit Liquor'),
    (901, 9, 'Rash Driving'), (902, 9, 'Fatal Road Accident'),
    (1001, 10, 'Criminal Intimidation'), (1002, 10, 'Illegal Arms'),
]
write('CrimeSubHead', ['CrimeSubHeadID', 'CrimeHeadID', 'CrimeHeadName', 'SeqID'],
      [[sid, hid, n, i + 1] for i, (sid, hid, n) in enumerate(sub_heads)])
SUBS_BY_HEAD = {}
for sid, hid, _ in sub_heads:
    SUBS_BY_HEAD.setdefault(hid, []).append(sid)

# Which act-sections realistically attach to each sub-head (used both for the
# CrimeHeadActSection mapping table and to generate per-case ActSectionAssociation).
SUB_SECTIONS = {
    101: [('IPC', '302')], 102: [('IPC', '307'), ('IPC', '324')],
    103: [('IPC', '324'), ('IPC', '323')], 104: [('IPC', '363')],
    105: [('IPC', '304A')],
    201: [('IPC', '379')], 202: [('IPC', '380')], 203: [('IPC', '392')],
    204: [('IPC', '395')], 205: [('IPC', '379')], 206: [('IPC', '379'), ('IPC', '392')],
    301: [('IPC', '376')], 302: [('IPC', '354')], 303: [('IPC', '498A'), ('DP', '3'), ('DP', '4')],
    304: [('IPC', '509')],
    401: [('POCSO', '4'), ('POCSO', '8')], 402: [('IPC', '363')],
    501: [('IPC', '420')], 502: [('IPC', '406')],
    601: [('IT', '66D'), ('IPC', '420')], 602: [('IT', '66C')], 603: [('IT', '67')],
    701: [('NDPS', '21'), ('NDPS', '22')], 702: [('NDPS', '20')],
    801: [('IPC', '147')], 802: [('KPA', '87')], 803: [('EXCISE', '32')],
    901: [('IPC', '279'), ('MV', '184')], 902: [('IPC', '304A'), ('IPC', '279')],
    1001: [('IPC', '506')], 1002: [('ARMS', '25')],
}
chas = []
for sid, hid, _ in sub_heads:
    for act, sec in SUB_SECTIONS[sid]:
        chas.append([hid, act, sec])
chas = [list(x) for x in dict.fromkeys(map(tuple, chas))]
write('CrimeHeadActSection', ['CrimeHeadID', 'ActCode', 'SectionCode'], chas)

# ── transactional tables ─────────────────────────────────────────────────────
#
# Volume is configurable because the dataset outgrew its first purpose. 2,200
# cases demonstrated every feature and made the analytics look thin: a
# co-offending network over 3,000 accused has few rings worth finding, and a
# district heat map built from 70 cases per district is mostly noise.
#
#   N_CASES=30000 python3 generate_fir_dataset.py
#
# The related tables scale with it — roughly 1.5 accused, 1.1 complainants,
# 0.9 victims, 0.8 arrests, 0.75 chargesheets and 1.15 act-sections per case —
# so 30,000 cases is about 216,000 rows in total.
N_CASES = int(os.environ.get('N_CASES', '2200'))
HEAD_WEIGHTS = {1: 10, 2: 24, 3: 12, 4: 4, 5: 10, 6: 16, 7: 7, 8: 6, 9: 8, 10: 3}
HEINOUS_SUBS = {101, 102, 204, 301, 401, 402, 902}
FACT_TMPL = {
    1: 'Complainant reported that the accused assaulted the victim near {place} following a dispute.',
    2: 'Complainant reported that unknown persons committed {sub} at {place} during the stated period.',
    3: 'Complainant reported an incident of {sub} against the victim at {place}.',
    4: 'Complainant reported an offence of {sub} involving a minor at {place}.',
    5: 'Complainant reported being cheated of money by the accused at {place} on false promises.',
    6: 'Complainant reported {sub} — money was fraudulently transferred after an online contact.',
    7: 'Acting on credible information, police intercepted the accused at {place} and seized contraband.',
    8: 'Police registered a case of {sub} at {place} based on patrol findings.',
    9: 'A road incident of {sub} occurred at {place} involving the accused vehicle.',
    10: 'Complainant reported an offence of {sub} at {place}.',
}
PLACES = ['Main Road', 'Bus Stand', 'Market Area', 'Railway Station Road', 'Old Town',
          'Industrial Area', 'College Circle', 'Temple Street', 'Ring Road', 'Gandhi Nagar']

# ─────────────────────────────────────────────────────────────────────────────
# Generative structure for the ML models
#
# Everything below exists so a trained model has something real to find. Before
# it, three things were drawn independently of everything else:
#
#   • CrimeRegisteredDate was uniform over the whole window — no trend, no
#     seasonality, a 5% weekday swing where a real city shows 20-40%.
#   • CrimeMajorHeadID was a fixed weighted draw, independent of when or where.
#   • Case outcome came from case AGE alone. Measured on the old data, every
#     other feature — crime head, gravity, station, category, accused count,
#     arrests, month — contributed exactly +0.00pp over the 74.9% majority
#     baseline. A classifier could reach 81% and every point of it was a
#     restatement of `today - registration_date`.
#
# A model trained on that would show an officer station-level and crime-head
# "risk" that does not exist in the data. So the quantities the models predict
# are now generated from observable case attributes plus noise.
#
# This is authored structure, not discovered structure. The dataset is
# synthetic, so a model can only ever recover the process written here — the
# honest claim is "the pipeline works and the model recovers the relationship
# we defined", never "these are real drivers of Karnataka case outcomes".
#
# Deliberately NOT drivers: religion, caste and gender. They exist in the
# schema because CCTNS records them, and no model in this project may use them
# as a feature. Making them predictive here would smuggle them into a model
# through the back door.
# ─────────────────────────────────────────────────────────────────────────────

# Seasonality: property crime climbs through the dry season and festival months,
# dips in the monsoon. Index by calendar month, 1.0 = average.
MONTH_FACTOR = {1: 1.02, 2: 0.96, 3: 1.05, 4: 1.10, 5: 1.12, 6: 0.88,
                7: 0.84, 8: 0.90, 9: 0.97, 10: 1.14, 11: 1.09, 12: 1.06}
# Weekend brawls and Monday reporting of weekend incidents. 0 = Monday.
WEEKDAY_FACTOR = {0: 1.08, 1: 0.97, 2: 0.95, 3: 0.96, 4: 1.04, 5: 1.12, 6: 1.06}
# A slow real rise in registrations across the window (better reporting).
TREND_PER_YEAR = 0.06

# Crime head by hour of the incident. Burglary and theft are night offences;
# road accidents cluster at rush hour; cyber-fraud is reported in office hours.
HEAD_BY_HOUR = {
    1: {'night': 1.5, 'day': 0.8, 'evening': 1.2},   # offences against person
    2: {'night': 2.1, 'day': 0.6, 'evening': 1.1},   # property / theft
    3: {'night': 1.4, 'day': 0.8, 'evening': 1.2},   # crimes against women
    4: {'night': 0.9, 'day': 1.2, 'evening': 1.0},   # crimes against children
    5: {'night': 0.5, 'day': 1.6, 'evening': 0.9},   # cheating
    6: {'night': 0.4, 'day': 1.9, 'evening': 0.8},   # cyber / online fraud
    7: {'night': 1.7, 'day': 0.7, 'evening': 1.1},   # contraband
    8: {'night': 1.3, 'day': 0.9, 'evening': 1.0},   # police-initiated
    9: {'night': 0.8, 'day': 1.3, 'evening': 1.4},   # road incidents
    10: {'night': 1.0, 'day': 1.0, 'evening': 1.0},  # other
}

def _hour_band(h):
    return 'night' if h < 6 or h >= 22 else ('day' if h < 17 else 'evening')

# How solvable a head is before any case detail: contraband and police-initiated
# cases arrive with the accused already identified; cyber-fraud rarely does.
HEAD_SOLVABILITY = {1: 0.55, 2: -0.35, 3: 0.40, 4: 0.35, 5: -0.10,
                    6: -0.80, 7: 1.30, 8: 1.10, 9: 0.60, 10: 0.00}

def _logistic(x):
    return 1.0 / (1.0 + math.exp(-x))


case_rows, complainants, victims, accused_rows = [], [], [], []
act_assoc, arrests, chargesheets = [], [], []
serials = {}
comp_id = vict_id = acc_id = arr_id = cs_id = 50001
today = date(2026, 7, 1)

# A pool of candidate registration days, each repeated in proportion to its
# seasonal x weekday x trend weight. Drawing uniformly FROM THIS POOL gives a
# date distribution with structure a forecaster can actually learn, while
# keeping the draw itself a single cheap index.
# A stable per-station workload factor in [0, 1]. Derived from the station id
# so it is deterministic and identical on every run, and used both as a driver
# of case outcome and as the reason chargesheets take longer at busy stations.
PS_LOAD = {}
for _u in ALL_PS:
    _h = (hash((_u, 'load')) if False else (_u * 2654435761) % 1000) / 1000.0
    PS_LOAD[_u] = round(0.15 + 0.70 * _h, 3)

# ── Districts do not all peak in the same month ──────────────────────────────
# Every district used to draw its dates from ONE pool, so all 31 shared a single
# seasonal shape. Knowing the district then told a forecaster nothing about
# WHEN — only how big the district was — and a district model could not beat a
# flat average (+1.8% median over rolling origins).
#
# The swing also has to clear the noise to be learnable. A district registering
# ~25 cases a month carries Poisson noise of about +/-20%, so the global +/-14%
# seasonal swing was inside the noise. These profiles run nearer +/-35%, which
# is both realistic for the geography and detectable at district grain.
DISTRICT_SEASON = {
    # Coastal: the south-west monsoon shuts activity down from June to August.
    'coastal': {1: 1.15, 2: 1.18, 3: 1.22, 4: 1.25, 5: 1.10, 6: 0.68,
                7: 0.62, 8: 0.70, 9: 0.88, 10: 1.05, 11: 1.12, 12: 1.15},
    # Malnad hill country: monsoon dip, then a tourist and harvest season.
    'malnad': {1: 1.10, 2: 1.05, 3: 1.00, 4: 1.02, 5: 0.95, 6: 0.72,
               7: 0.70, 8: 0.78, 9: 0.95, 10: 1.20, 11: 1.28, 12: 1.25},
    # Northern dry belt: peaks at harvest and through the dry pre-monsoon months.
    'agrarian_north': {1: 1.05, 2: 1.12, 3: 1.28, 4: 1.32, 5: 1.25, 6: 0.85,
                       7: 0.72, 8: 0.72, 9: 0.85, 10: 1.02, 11: 1.10, 12: 1.02},
    # Metro: flatter overall, with festival and year-end peaks.
    'metro': {1: 1.02, 2: 0.94, 3: 0.98, 4: 1.00, 5: 1.04, 6: 0.94,
              7: 0.92, 8: 0.98, 9: 1.06, 10: 1.22, 11: 1.18, 12: 1.12},
    # Southern plains: closest to the statewide average.
    'plains': dict(MONTH_FACTOR),
}
DISTRICT_SEASON_GROUP = {
    'Dakshina Kannada': 'coastal', 'Udupi': 'coastal', 'Uttara Kannada': 'coastal',
    'Kodagu': 'malnad', 'Chikkamagaluru': 'malnad', 'Shivamogga': 'malnad',
    'Hassan': 'malnad',
    'Kalaburagi': 'agrarian_north', 'Yadgir': 'agrarian_north',
    'Raichur': 'agrarian_north', 'Koppal': 'agrarian_north',
    'Ballari': 'agrarian_north', 'Vijayanagara': 'agrarian_north',
    'Bidar': 'agrarian_north', 'Vijayapura': 'agrarian_north',
    'Bagalkote': 'agrarian_north', 'Belagavi': 'agrarian_north',
    'Gadag': 'agrarian_north', 'Haveri': 'agrarian_north', 'Dharwad': 'metro',
    'Bengaluru City': 'metro', 'Bengaluru Rural': 'metro', 'Mysuru': 'metro',
}
# Anything unnamed follows the statewide shape.
DISTRICT_GROUP_BY_ID = {
    d: DISTRICT_SEASON_GROUP.get(n, 'plains') for d, n in DISTRICTS_BY_ID.items()
}

_START = date(2023, 1, 1)
_SPAN = (today - _START).days

def _day_pool(month_factor):
    """Dates repeated in proportion to season x weekday x trend.

    Drawing uniformly from the pool then yields a date distribution carrying
    that structure, while the draw itself stays a single cheap index.
    """
    pool = []
    for _i in range(_SPAN + 1):
        _d = _START + timedelta(days=_i)
        _w = (month_factor[_d.month]
              * WEEKDAY_FACTOR[_d.weekday()]
              * (1.0 + TREND_PER_YEAR * (_i / 365.0)))
        pool.extend([_d] * max(1, int(round(_w * 10))))
    return pool

REG_DAYS_BY_GROUP = {g: _day_pool(f) for g, f in DISTRICT_SEASON.items()}
# Kept for anything still reading the statewide pool.
REG_DAYS = REG_DAYS_BY_GROUP['plains']


# A deliberate hole in the data.
#
# The benchmark checks that the assistant REFUSES a question the records cannot
# answer, and that check needs a combination with genuinely nothing behind it.
# At 2,200 cases such gaps occurred naturally; at 30,000 every one of the 961
# district x sub-head combinations is populated, and the abstention test had
# nothing left to fire at.
#
# So one is reserved: no illegal-arms cases are recorded in Kodagu. It is
# documented here rather than left as a coincidence, because a planted gap
# nobody knows about looks exactly like a bug in the generator.
NO_DATA_GAP = ('Kodagu', 1002)   # (district name, CrimeMinorHeadID for Illegal Arms)

for cm_id in range(1, N_CASES + 1):
    ps = PS_RNG.choices(ALL_PS, weights=PS_WEIGHTS)[0]
    did = PS_DISTRICT[ps]
    cat = random.choices([1, 3, 4, 8], weights=[85, 8, 4, 3])[0]
    _pool = REG_DAYS_BY_GROUP[DISTRICT_GROUP_BY_ID[did]]
    reg = _pool[random.randrange(len(_pool))]
    year = reg.year
    key = (ps, cat, year)
    serials[key] = serials.get(key, 0) + 1
    crime_no = f'{cat}{did:04d}{ps:04d}{year}{serials[key]:05d}'
    case_no = crime_no[-9:]

    # The incident hour is drawn first, because the kind of offence depends on
    # it: burglary is a night crime, cyber-fraud is reported in office hours.
    # This is what gives a crime-head classifier something to learn from.
    inc_hour = random.randrange(24)
    _band = _hour_band(inc_hour)
    _hw = [HEAD_WEIGHTS[h] * HEAD_BY_HOUR[h][_band] for h in HEAD_WEIGHTS]
    head = random.choices(list(HEAD_WEIGHTS), weights=_hw)[0]
    sub = random.choice(SUBS_BY_HEAD[head])
    if cat == 3:  # UDR — unnatural death
        head, sub = 1, 105
    # Keep the reserved combination empty (see NO_DATA_GAP). Redrawn rather
    # than dropped, so the case count stays exactly N_CASES.
    gap_district, gap_sub = NO_DATA_GAP
    while DISTRICTS_BY_ID.get(did) == gap_district and sub == gap_sub:
        head = random.choices(list(HEAD_WEIGHTS), weights=_hw)[0]
        sub = random.choice(SUBS_BY_HEAD[head])
    gravity = 1 if sub in HEINOUS_SUBS else 2
    age_days = (today - reg).days

    # ── Whether this case gets solved ───────────────────────────────────────
    # A latent solvability score from things an officer can see at
    # registration, which is the whole point: a model may only use features
    # that exist when the prediction would actually be made.
    #
    #   named accused   the single strongest driver — a case with an
    #                   identified accused is a different case
    #   crime head      contraband and police-initiated cases arrive solved;
    #                   cyber-fraud usually does not
    #   gravity         heinous offences draw investigative effort
    #   station load    a station carrying more cases closes a smaller share
    #
    # Age still matters, but it now moves the outcome rather than determining
    # it: an old case has had time to progress, not a guaranteed result.
    n_named = random.choices([0, 1, 2, 3, 4], weights=[18, 45, 22, 10, 5])[0]
    ps_load = PS_LOAD[ps]
    solve = (
        -0.55
        + 1.65 * (1 if n_named else 0)
        + 0.22 * min(n_named, 3)
        + HEAD_SOLVABILITY[head]
        + (0.45 if gravity == 1 else 0.0)
        - 1.30 * ps_load
        + 0.90 * min(age_days, 540) / 540.0
        + random.gauss(0, 0.55)
    )
    solved = random.random() < _logistic(solve)

    # Status is now a consequence of the outcome, not its cause. A case with no
    # identified accused and no progress is undetected (7); an unsolved case
    # still under work is open (1); a solved case moves along the court track.
    if not solved:
        status = 7 if n_named == 0 and age_days > 180 else 1
    elif age_days > 540:
        status = random.choices([2, 3, 4, 5, 6], weights=[12, 30, 24, 18, 16])[0]
    elif age_days > 180:
        status = random.choices([2, 3, 6], weights=[55, 30, 15])[0]
    else:
        status = 2

    inc_from = (datetime.combine(reg - timedelta(days=random.randint(0, 3)),
                                 datetime.min.time())
                + timedelta(hours=inc_hour, minutes=random.randrange(60)))
    inc_to = inc_from + timedelta(minutes=random.randint(10, 720))
    info = datetime.combine(reg, datetime.min.time()) + timedelta(minutes=random.randint(360, 1380))
    lat0, lon0 = DIST_GEO[did]
    lat = round(lat0 + random.uniform(-0.15, 0.15), 6)
    lon = round(lon0 + random.uniform(-0.15, 0.15), 6)
    officer = random.choice(EMP_BY_PS[ps])
    court = random.choice(COURT_BY_DIST[did])
    sub_name = next(n for s, h, n in sub_heads if s == sub)
    facts = FACT_TMPL[head].format(sub=sub_name.lower(), place=random.choice(PLACES))

    case_rows.append([cm_id, crime_no, case_no, reg.isoformat(), officer, ps, cat,
                      gravity, head, sub, status, court,
                      inc_from.strftime('%Y-%m-%d %H:%M:%S'),
                      inc_to.strftime('%Y-%m-%d %H:%M:%S'),
                      info.strftime('%Y-%m-%d %H:%M:%S'), lat, lon, facts])

    # complainant(s)
    for _ in range(random.choices([1, 2], weights=[92, 8])[0]):
        g = random.choices([1, 2], weights=[65, 35])[0]
        complainants.append([comp_id, cm_id, person(g), random.randint(18, 75),
                             random.randint(1, len(occupations)),
                             random.choices(range(1, 8), weights=[70, 13, 8, 3, 2, 2, 2])[0],
                             random.randint(1, 10), g])
        comp_id += 1

    # victims (crimes against women/children skew female/young)
    n_vict = 1 if head in (3, 4) or cat == 3 else random.choices([0, 1, 2], weights=[25, 60, 15])[0]
    for _ in range(n_vict):
        g = 2 if head == 3 else random.choices([1, 2], weights=[55, 45])[0]
        age = random.randint(4, 17) if head == 4 else random.randint(18, 80)
        victims.append([vict_id, cm_id, person(g), age, g,
                        1 if random.random() < 0.02 else 0])
        vict_id += 1

    # accused — drawn above as n_named, because whether an accused was
    # identified is what drives the outcome rather than following from it
    n_acc = n_named
    case_accused = []
    for i in range(n_acc):
        g = random.choices([1, 2], weights=[88, 12])[0]
        accused_rows.append([acc_id, cm_id, person(g), random.randint(18, 65), g, f'A{i + 1}'])
        case_accused.append(acc_id)
        acc_id += 1

    # act-section associations
    secs = SUB_SECTIONS[sub][:]
    random.shuffle(secs)
    for order, (act, sec) in enumerate(secs[:random.randint(1, len(secs))], start=1):
        act_assoc.append([cm_id, act, sec, order, order])

    # arrests / surrenders
    arrest_made = False
    for a_id in case_accused:
        # Arrest is likelier on the cases that were going to be solved, which
        # is why arrest-made is a genuine signal rather than a coin flip.
        if random.random() < (0.78 if solved else 0.28):
            arrest_made = True
            a_date = reg + timedelta(days=random.randint(0, min(300, max(1, age_days))))
            in_ka = random.random() < 0.95
            a_state = 1 if in_ka else random.choice([s for s, _ in STATES[1:]])
            a_dist = did if in_ka else random.choice(
                [d for d, _, s in OTHER_DISTRICTS if s == a_state] or [OTHER_DISTRICTS[0][0]])
            arrests.append([arr_id, cm_id, random.choices([1, 2], weights=[88, 12])[0],
                            a_date.isoformat(), a_state, a_dist, ps,
                            random.choice(EMP_BY_PS[ps]), court, a_id, 'true',
                            'true' if random.random() < 0.02 else 'false'])
            arr_id += 1

    # ── Chargesheet, and how long it took ───────────────────────────────────
    # Filed only for solved cases that have had time to reach it. The LAG is
    # the regression target, and it is generated from case attributes so there
    # is something to predict: heinous and multi-accused cases take longer, a
    # loaded station takes longer still, an arrest shortens it.
    if solved and age_days > 35:
        lag = (55
               + 38 * (1 if gravity == 1 else 0)
               + 14 * min(n_named, 3)
               + 95 * ps_load
               - 22 * (1 if arrest_made else 0)
               + random.gauss(0, 26))
        lag = int(max(30, min(400, min(lag, max(31, age_days)))))
        cs_date = (datetime.combine(reg + timedelta(days=lag), datetime.min.time())
                   + timedelta(minutes=random.randint(540, 1020)))
        cstype = 'A' if status in (2, 3, 4, 5) else ('B' if status == 6 else 'C')
        chargesheets.append([cs_id, cm_id, cs_date.strftime('%Y-%m-%d %H:%M:%S'), cstype, officer])
        cs_id += 1

write('CaseMaster', ['CaseMasterID', 'CrimeNo', 'CaseNo', 'CrimeRegisteredDate',
                     'PolicePersonID', 'PoliceStationID', 'CaseCategoryID',
                     'GravityOffenceID', 'CrimeMajorHeadID', 'CrimeMinorHeadID',
                     'CaseStatusID', 'CourtID', 'IncidentFromDate', 'IncidentToDate',
                     'InfoReceivedPSDate', 'latitude', 'longitude', 'BriefFacts'], case_rows)
write('ComplainantDetails', ['ComplainantID', 'CaseMasterID', 'ComplainantName',
                             'AgeYear', 'OccupationID', 'ReligionID', 'CasteID',
                             'GenderID'], complainants)
write('Victim', ['VictimMasterID', 'CaseMasterID', 'VictimName', 'AgeYear',
                 'GenderID', 'VictimPolice'], victims)
write('Accused', ['AccusedMasterID', 'CaseMasterID', 'AccusedName', 'AgeYear',
                  'GenderID', 'PersonID'], accused_rows)
write('ActSectionAssociation', ['CaseMasterID', 'ActID', 'SectionID', 'ActOrderID',
                                'SectionOrderID'], act_assoc)
write('ArrestSurrender', ['ArrestSurrenderID', 'CaseMasterID', 'ArrestSurrenderTypeID',
                          'ArrestSurrenderDate', 'ArrestSurrenderStateId',
                          'ArrestSurrenderDistrictId', 'PoliceStationID', 'IOID',
                          'CourtID', 'AccusedMasterID', 'IsAccused',
                          'IsComplainantAccused'], arrests)
write('ChargesheetDetails', ['CSID', 'CaseMasterID', 'csdate', 'cstype',
                             'PolicePersonID'], chargesheets)

print('\nDone. All CSVs written to', OUT)
