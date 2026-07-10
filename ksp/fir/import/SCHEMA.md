.# Catalyst Data Store — table schemas

_Generated 2026-07-10 20:58 • bucket: `accused`_

Every table also gets an automatic `ROWID` primary key from Catalyst — you don't add it. Create each table below in the console (Data Store → New Table), then run `run_import.sh`.


## `Accused`  (2956 rows)

| Column | Type | Max length |
|--------|------|-----------|
| AccusedMasterID | int |  |
| CaseMasterID | int |  |
| AccusedName | varchar | 50 |
| AgeYear | int |  |
| GenderID | int |  |
| PersonID | varchar | 50 |

## `Act`  (10 rows)

| Column | Type | Max length |
|--------|------|-----------|
| ActCode | varchar | 50 |
| ActDescription | varchar | 100 |
| ShortName | varchar | 50 |
| Active | boolean |  |

## `ActSectionAssociation`  (2535 rows)

| Column | Type | Max length |
|--------|------|-----------|
| CaseMasterID | int |  |
| ActID | varchar | 50 |
| SectionID | varchar | 50 |
| ActOrderID | int |  |
| SectionOrderID | int |  |

## `ArrestSurrender`  (1803 rows)

| Column | Type | Max length |
|--------|------|-----------|
| ArrestSurrenderID | int |  |
| CaseMasterID | int |  |
| ArrestSurrenderTypeID | int |  |
| ArrestSurrenderDate | datetime |  |
| ArrestSurrenderStateId | int |  |
| ArrestSurrenderDistrictId | int |  |
| PoliceStationID | int |  |
| IOID | int |  |
| CourtID | int |  |
| AccusedMasterID | int |  |
| IsAccused | boolean |  |
| IsComplainantAccused | boolean |  |

## `CaseCategory`  (4 rows)

| Column | Type | Max length |
|--------|------|-----------|
| CaseCategoryID | int |  |
| LookupValue | varchar | 50 |

## `CaseMaster`  (2200 rows)

| Column | Type | Max length |
|--------|------|-----------|
| CaseMasterID | int |  |
| CrimeNo | bigint |  |
| CaseNo | int |  |
| CrimeRegisteredDate | datetime |  |
| PolicePersonID | int |  |
| PoliceStationID | int |  |
| CaseCategoryID | int |  |
| GravityOffenceID | int |  |
| CrimeMajorHeadID | int |  |
| CrimeMinorHeadID | int |  |
| CaseStatusID | int |  |
| CourtID | int |  |
| IncidentFromDate | datetime |  |
| IncidentToDate | datetime |  |
| InfoReceivedPSDate | datetime |  |
| latitude | double |  |
| longitude | double |  |
| BriefFacts | varchar | 150 |

## `CaseStatusMaster`  (7 rows)

| Column | Type | Max length |
|--------|------|-----------|
| CaseStatusID | int |  |
| CaseStatusName | varchar | 50 |

## `CasteMaster`  (10 rows)

| Column | Type | Max length |
|--------|------|-----------|
| caste_master_id | int |  |
| caste_master_name | varchar | 50 |

## `ChargesheetDetails`  (1658 rows)

| Column | Type | Max length |
|--------|------|-----------|
| CSID | int |  |
| CaseMasterID | int |  |
| csdate | datetime |  |
| cstype | varchar | 50 |
| PolicePersonID | int |  |

## `ComplainantDetails`  (2374 rows)

| Column | Type | Max length |
|--------|------|-----------|
| ComplainantID | int |  |
| CaseMasterID | int |  |
| ComplainantName | varchar | 50 |
| AgeYear | int |  |
| OccupationID | int |  |
| ReligionID | int |  |
| CasteID | int |  |
| GenderID | int |  |

## `Court`  (62 rows)

| Column | Type | Max length |
|--------|------|-----------|
| CourtID | int |  |
| CourtName | varchar | 50 |
| DistrictID | int |  |
| StateID | int |  |
| Active | boolean |  |

## `CrimeHead`  (10 rows)

| Column | Type | Max length |
|--------|------|-----------|
| CrimeHeadID | int |  |
| CrimeGroupName | varchar | 50 |
| Active | boolean |  |

## `CrimeHeadActSection`  (36 rows)

| Column | Type | Max length |
|--------|------|-----------|
| CrimeHeadID | int |  |
| ActCode | varchar | 50 |
| SectionCode | varchar | 50 |

## `CrimeSubHead`  (31 rows)

| Column | Type | Max length |
|--------|------|-----------|
| CrimeSubHeadID | int |  |
| CrimeHeadID | int |  |
| CrimeHeadName | varchar | 50 |
| SeqID | int |  |

## `Designation`  (6 rows)

| Column | Type | Max length |
|--------|------|-----------|
| DesignationID | int |  |
| DesignationName | varchar | 50 |
| Active | boolean |  |
| SortOrder | int |  |

## `District`  (39 rows)

| Column | Type | Max length |
|--------|------|-----------|
| DistrictID | int |  |
| DistrictName | varchar | 50 |
| StateID | int |  |
| Active | boolean |  |

## `Employee`  (744 rows)

| Column | Type | Max length |
|--------|------|-----------|
| EmployeeID | int |  |
| DistrictID | int |  |
| UnitID | int |  |
| RankID | int |  |
| DesignationID | int |  |
| KGID | varchar | 50 |
| FirstName | varchar | 50 |
| EmployeeDOB | datetime |  |
| GenderID | int |  |
| BloodGroupID | int |  |
| PhysicallyChallenged | boolean |  |
| AppointmentDate | datetime |  |

## `GravityOffence`  (2 rows)

| Column | Type | Max length |
|--------|------|-----------|
| GravityOffenceID | int |  |
| LookupValue | varchar | 50 |

## `OccupationMaster`  (14 rows)

| Column | Type | Max length |
|--------|------|-----------|
| OccupationID | int |  |
| OccupationName | varchar | 50 |

## `Rank`  (9 rows)

| Column | Type | Max length |
|--------|------|-----------|
| RankID | int |  |
| RankName | varchar | 50 |
| Hierarchy | int |  |
| Active | boolean |  |

## `ReligionMaster`  (7 rows)

| Column | Type | Max length |
|--------|------|-----------|
| ReligionID | int |  |
| ReligionName | varchar | 50 |

## `Section`  (35 rows)

| Column | Type | Max length |
|--------|------|-----------|
| ActCode | varchar | 50 |
| SectionCode | varchar | 50 |
| SectionDescription | varchar | 50 |
| Active | boolean |  |

## `State`  (7 rows)

| Column | Type | Max length |
|--------|------|-----------|
| StateID | int |  |
| StateName | varchar | 50 |
| NationalityID | int |  |
| Active | boolean |  |

## `Unit`  (155 rows)

| Column | Type | Max length |
|--------|------|-----------|
| UnitID | int |  |
| UnitName | varchar | 50 |
| TypeID | int |  |
| ParentUnit | int |  |
| NationalityID | int |  |
| StateID | int |  |
| DistrictID | int |  |
| Active | boolean |  |

## `UnitType`  (6 rows)

| Column | Type | Max length |
|--------|------|-----------|
| UnitTypeID | int |  |
| UnitTypeName | varchar | 50 |
| CityDistState | varchar | 50 |
| Hierarchy | int |  |
| Active | boolean |  |

## `Victim`  (1988 rows)

| Column | Type | Max length |
|--------|------|-----------|
| VictimMasterID | int |  |
| CaseMasterID | int |  |
| VictimName | varchar | 50 |
| AgeYear | int |  |
| GenderID | int |  |
| VictimPolice | int |  |
