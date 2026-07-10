#!/usr/bin/env python3
"""Convert ISO-8601 datetimes (2025-08-09T22:26:00Z) to Catalyst format
(2025-08-09 22:26:00) for every cell in a CSV. Writes <name>_fixed.csv."""
import csv
import re
import sys

ISO = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$")


def fix(v):
    m = ISO.match(v.strip())
    return f"{m.group(1)} {m.group(2)}" if m else v


src = sys.argv[1]
dst = src.rsplit(".", 1)[0] + "_fixed.csv"
changed = 0
with open(src, newline="", encoding="utf-8") as fi, open(dst, "w", newline="", encoding="utf-8") as fo:
    r = csv.reader(fi)
    w = csv.writer(fo)
    for i, row in enumerate(r):
        if i == 0:
            w.writerow(row)
            continue
        new = [fix(c) for c in row]
        changed += sum(1 for a, b in zip(row, new) if a != b)
        w.writerow(new)
print(f"wrote {dst}; converted {changed} datetime cells")
