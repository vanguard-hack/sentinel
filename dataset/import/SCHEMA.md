# Catalyst Data Store — table schemas

_Generated 2026-07-06 12:42 • bucket: `accused`_

Every table also gets an automatic `ROWID` primary key from Catalyst — you don't add it. Create each table below in the console (Data Store → New Table), then run `run_import.sh`.


## `accused`  (2500 rows)

| Column | Type | Max length |
|--------|------|-----------|
| accused_id | int |  |
| name | varchar | 50 |
| gender | varchar | 50 |
| age | int |  |
| dob | datetime |  |
| address_district | varchar | 50 |
| nationality | varchar | 50 |
| occupation | varchar | 50 |
| education | varchar | 50 |
| socioeconomic_band | varchar | 50 |
| prior_record_flag | int |  |
| total_prior_cases | int |  |
| is_habitual_offender | int |  |
| is_gang_member | int |  |
| gang_id | int |  |
| arrest_status | varchar | 50 |
| arrest_date | datetime |  |

## `accused_plan`  (2500 rows)

| Column | Type | Max length |
|--------|------|-----------|
| accused_id | int |  |
| fir_target | int |  |
| signature_mo | varchar | 50 |
| op_districts | varchar | 100 |
| tier | varchar | 50 |

## `beats`  (559 rows)

| Column | Type | Max length |
|--------|------|-----------|
| beat_id | varchar | 50 |
| station_id | int |  |
| district | varchar | 50 |
| beat_name | varchar | 50 |
| latitude | double |  |
| longitude | double |  |
| is_hotspot | int |  |
| hotspot_multiplier | double |  |

## `crime_classification`  (5000 rows)

| Column | Type | Max length |
|--------|------|-----------|
| crime_class_id | int |  |
| fir_id | int |  |
| major_head | varchar | 50 |
| minor_head | varchar | 50 |
| ipc_bns_sections | varchar | 50 |
| sll_act | varchar | 50 |
| attempt_commission_flag | int |  |
| modus_operandi_code | varchar | 50 |

## `fir`  (5000 rows)

| Column | Type | Max length |
|--------|------|-----------|
| fir_id | int |  |
| fir_number | varchar | 50 |
| station_id | int |  |
| district | varchar | 50 |
| fir_date | datetime |  |
| fir_time | varchar | 50 |
| occurrence_date_from | varchar | 50 |
| occurrence_date_to | varchar | 50 |
| reported_delay_hours | double |  |
| latitude | double |  |
| longitude | double |  |
| beat_id | varchar | 50 |
| complaint_mode | varchar | 50 |
| gd_entry_no | varchar | 50 |
| info_type | varchar | 50 |
| case_status | varchar | 50 |
| io_officer_id | int |  |

## `fir_accused_link`  (3122 rows)

| Column | Type | Max length |
|--------|------|-----------|
| link_id | int |  |
| fir_id | int |  |
| accused_id | int |  |
| role | varchar | 50 |
| mo_used | varchar | 50 |

## `fir_link_plan`  (3122 rows)

| Column | Type | Max length |
|--------|------|-----------|
| link_id | int |  |
| fir_id | int |  |
| accused_id | int |  |
| role | varchar | 50 |
| mo_used | varchar | 50 |

## `fir_plan`  (5000 rows)

| Column | Type | Max length |
|--------|------|-----------|
| fir_id | int |  |
| major_head | varchar | 50 |
| minor_head | varchar | 50 |
| category | varchar | 50 |
| mo_code | varchar | 50 |
| bns | varchar | 50 |
| ipc | varchar | 50 |
| sll_act | varchar | 50 |
| attempt | int |  |
| detected | int |  |
| district | varchar | 50 |
| occ_epoch | bigint |  |
| n_accused | int |  |
| n_victims | int |  |

## `gangs`  (12 rows)

| Column | Type | Max length |
|--------|------|-----------|
| gang_id | int |  |
| gang_name | varchar | 50 |
| gang_type | varchar | 50 |
| base_district | varchar | 50 |
| estimated_size | int |  |
| active_since | int |  |
| lead_accused_id | int |  |

## `investigation_officers`  (432 rows)

| Column | Type | Max length |
|--------|------|-----------|
| officer_id | int |  |
| rank | varchar | 50 |
| station_id | int |  |
| cases_assigned | int |  |
| cases_solved | int |  |

## `modus_operandi`  (31 rows)

| Column | Type | Max length |
|--------|------|-----------|
| mo_code | varchar | 50 |
| mo_description | varchar | 50 |
| crime_category | varchar | 50 |
| typical_time_window | varchar | 50 |
| tool_used | varchar | 50 |

## `network_edges`  (197 rows)

| Column | Type | Max length |
|--------|------|-----------|
| edge_id | int |  |
| source_accused_id | int |  |
| target_accused_id | int |  |
| edge_type | varchar | 50 |
| shared_fir_count | int |  |
| weight | double |  |

## `police_stations`  (144 rows)

| Column | Type | Max length |
|--------|------|-----------|
| station_id | int |  |
| station_name | varchar | 50 |
| station_code | varchar | 50 |
| district | varchar | 50 |
| sub_division | varchar | 50 |
| range | varchar | 50 |
| commissionerate_flag | int |  |
| latitude | double |  |
| longitude | double |  |
| urban_rural | varchar | 50 |
| population_covered | int |  |
| sanctioned_strength | int |  |
| actual_strength | int |  |

## `property`  (2654 rows)

| Column | Type | Max length |
|--------|------|-----------|
| property_id | int |  |
| fir_id | int |  |
| property_type | varchar | 50 |
| value_inr | int |  |
| status | varchar | 50 |
| recovery_date | datetime |  |
| recovery_value_inr | int |  |

## `socioeconomic_indicators`  (34 rows)

| Column | Type | Max length |
|--------|------|-----------|
| district | varchar | 50 |
| population | int |  |
| pop_density | int |  |
| urbanization_pct | int |  |
| literacy_rate | double |  |
| unemployment_rate | double |  |
| median_income_band | varchar | 50 |
| night_lighting_index | double |  |
| liquor_outlets_per_lakh | double |  |

## `victims`  (5640 rows)

| Column | Type | Max length |
|--------|------|-----------|
| victim_id | int |  |
| fir_id | int |  |
| name | varchar | 50 |
| gender | varchar | 50 |
| age | int |  |
| injury_type | varchar | 50 |
| relation_to_accused | varchar | 50 |
| socioeconomic_band | varchar | 50 |
| compensation_flag | int |  |

## ⚠️ Row-limit warnings

- **victims**: 5640 rows > 5000 dev-env cap. Split the CSV (see run_import.sh) or import in Production.
