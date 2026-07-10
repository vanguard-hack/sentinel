#!/usr/bin/env python3
"""
Prepare Catalyst Data Store import for every CSV in ksp/.

Produces, per CSV file <name>.csv:
  1. ksp/import/configs/<name>.json  -> non-interactive `catalyst ds:import --config` file
  2. A consolidated ksp/import/SCHEMA.md -> exact columns + inferred Catalyst types,
     so you can create each table in the Catalyst console quickly.

It does NOT create tables (the CLI cannot; Catalyst has no table-create command and
there is no reusable OAuth token). Create the tables first from SCHEMA.md, then run
run_import.sh.

Usage:
    python3 prepare_import.py                 # bucket defaults to $CATALYST_BUCKET or "accused"
    CATALYST_BUCKET=crime-data python3 prepare_import.py
"""
import csv
import json
import os
import re
from datetime import datetime

KSP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_DIR = os.path.join(KSP_DIR, "import")
CFG_DIR = os.path.join(OUT_DIR, "configs")
BUCKET = os.environ.get("CATALYST_BUCKET", "accused")

# Dev environment caps a single bulk import at 5,000 rows.
DEV_ROW_LIMIT = 5000

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$")
INT_RE = re.compile(r"^-?\d+$")
FLOAT_RE = re.compile(r"^-?\d+\.\d+$")
BOOL_VALUES = {"true", "false"}
INT32_MAX = 2**31 - 1


def infer_column(values):
    """Infer a Catalyst column type from a sample of non-empty string values."""
    vals = [v.strip() for v in values if v is not None and v.strip() != ""]
    if not vals:
        return {"type": "text", "max_length": 255, "note": "all-empty; defaulted to text"}

    def all_match(pred):
        return all(pred(v) for v in vals)

    if all_match(lambda v: v.lower() in BOOL_VALUES):
        return {"type": "boolean"}
    if all_match(lambda v: INT_RE.match(v) is not None):
        big = any(abs(int(v)) > INT32_MAX for v in vals)
        return {"type": "bigint" if big else "int"}
    if all_match(lambda v: INT_RE.match(v) or FLOAT_RE.match(v)):
        return {"type": "double"}
    if all_match(lambda v: DATE_RE.match(v) is not None):
        return {"type": "datetime"}

    max_len = max(len(v) for v in vals)
    if max_len > 255:
        return {"type": "text", "max_length": min(max_len, 65535)}
    # round up to a tidy length with headroom
    length = min(max(50, ((max_len // 50) + 1) * 50), 255)
    return {"type": "varchar", "max_length": length}


def profile_csv(path, sample_rows=2000):
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        cols = {h: [] for h in header}
        total = 0
        for i, row in enumerate(reader):
            total += 1
            if i < sample_rows:
                for h, v in zip(header, row):
                    cols[h].append(v)
        schema = [{"name": h, **infer_column(cols[h])} for h in header]
    return header, schema, total


def main():
    os.makedirs(CFG_DIR, exist_ok=True)
    md = ["# Catalyst Data Store — table schemas\n",
          f"_Generated {datetime.now():%Y-%m-%d %H:%M} • bucket: `{BUCKET}`_\n",
          "Every table also gets an automatic `ROWID` primary key from Catalyst — "
          "you don't add it. Create each table below in the console "
          "(Data Store → New Table), then run `run_import.sh`.\n"]
    warnings = []

    for fname in sorted(os.listdir(KSP_DIR)):
        if not fname.endswith(".csv"):
            continue
        path = os.path.join(KSP_DIR, fname)
        table = fname[:-4]  # strip .csv
        header, schema, rows = profile_csv(path)

        # import config (object_key = local path; --config mode uploads it non-interactively)
        cfg = {
            "table_identifier": table,
            "operation": "insert",
            "object_details": {"bucket_name": BUCKET, "object_key": path},
        }
        with open(os.path.join(CFG_DIR, f"{table}.json"), "w") as fh:
            json.dump(cfg, fh, indent=2)

        md.append(f"\n## `{table}`  ({rows} rows)\n")
        md.append("| Column | Type | Max length |")
        md.append("|--------|------|-----------|")
        for c in schema:
            ml = c.get("max_length", "")
            md.append(f"| {c['name']} | {c['type']} | {ml} |")

        if rows > DEV_ROW_LIMIT:
            warnings.append(
                f"- **{table}**: {rows} rows > {DEV_ROW_LIMIT} dev-env cap. "
                f"Split the CSV (see run_import.sh) or import in Production.")

    if warnings:
        md.append("\n## ⚠️ Row-limit warnings\n")
        md.extend(warnings)

    with open(os.path.join(OUT_DIR, "SCHEMA.md"), "w") as fh:
        fh.write("\n".join(md) + "\n")

    print(f"Wrote {len(os.listdir(CFG_DIR))} configs to {CFG_DIR}")
    print(f"Wrote schema report to {os.path.join(OUT_DIR, 'SCHEMA.md')}")
    if warnings:
        print("\nRow-limit warnings:")
        print("\n".join(warnings))


if __name__ == "__main__":
    main()
