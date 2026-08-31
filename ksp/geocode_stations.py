#!/usr/bin/env python3
"""One-time reverse-geocode of every Karnataka police station.

The station GeoJSON carries coordinates but no street address — neither the
`Unit` master table nor police_stations.csv has an address column. The Crime Map
therefore used to reverse-geocode each station live, on click, against the public
Nominatim instance.

That works for a demo and does not scale. Nominatim's usage policy caps the
public instance at 1 request/second, forbids bulk use, and reserves the right to
block: a few thousand officers browsing the map would get the deployment's IP
blocked and every address would silently degrade to "—". So the lookup is done
ONCE, here, and the answer is baked into the GeoJSON that ships with the app.

That removes the runtime dependency entirely, makes addresses appear instantly
instead of after a network round-trip, and — because the data is now in the
repo — lets the address be used anywhere else it is wanted.

Usage:
    python3 ksp/geocode_stations.py              # geocode everything still missing
    python3 ksp/geocode_stations.py --limit 20   # try a small batch first
    python3 ksp/geocode_stations.py --force      # re-geocode even those already done

The run is RESUMABLE: results are appended to a cache keyed by station id, so an
interrupted run (or a re-run) never re-requests an address it already has. At the
policy's 1 req/sec, a full cold run of ~921 stations takes about 17 minutes.
"""

import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# A python.org build on macOS ships no CA bundle of its own, so an HTTPS request
# fails with CERTIFICATE_VERIFY_FAILED until it is pointed at one. Prefer
# certifi; fall back to the system default so this still runs where certifi is
# absent (a Homebrew or Linux python usually has working defaults).
try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEOJSON = os.path.join(ROOT, 'react-app/public/maps/karnataka-police-stations.geojson')
CACHE = os.path.join(ROOT, 'ksp/.geocode-cache.json')

# Nominatim requires a real identifying User-Agent — a generic one is grounds for
# blocking. See https://operations.osmfoundation.org/policies/nominatim/
UA = 'Sentinel-KSP/1.0 (Karnataka State Police datathon prototype; one-time station geocode)'
DELAY = 1.1  # seconds between requests; the policy's hard limit is 1/sec


def load_cache():
    if os.path.exists(CACHE):
        with open(CACHE, encoding='utf-8') as fh:
            return json.load(fh)
    return {}


def save_cache(cache):
    with open(CACHE, 'w', encoding='utf-8') as fh:
        json.dump(cache, fh, indent=1, ensure_ascii=False, sort_keys=True)


def reverse(lat, lon):
    """One reverse-geocode. Returns a display address, or None on any failure."""
    qs = urllib.parse.urlencode({
        'format': 'jsonv2', 'lat': lat, 'lon': lon,
        'zoom': 16, 'addressdetails': 1,
    })
    req = urllib.request.Request(
        f'https://nominatim.openstreetmap.org/reverse?{qs}',
        headers={'User-Agent': UA, 'Accept': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        return data.get('display_name') or None
    except urllib.error.HTTPError as e:
        # 429 means we are going too fast despite the delay; back off hard rather
        # than hammering an instance that is asking us to stop.
        if e.code == 429:
            print('    rate limited — backing off 60s', file=sys.stderr)
            time.sleep(60)
        else:
            print(f'    HTTP {e.code}', file=sys.stderr)
        return None
    except Exception as e:  # network, timeout, bad JSON
        print(f'    {type(e).__name__}: {e}', file=sys.stderr)
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, help='stop after N lookups (for a trial run)')
    ap.add_argument('--force', action='store_true', help='re-geocode stations already cached')
    args = ap.parse_args()

    with open(GEOJSON, encoding='utf-8') as fh:
        geo = json.load(fh)
    feats = geo['features']
    cache = {} if args.force else load_cache()

    todo = []
    for f in feats:
        sid = str(f['properties'].get('id'))
        if not args.force and cache.get(sid):
            continue
        todo.append(f)
    if args.limit:
        todo = todo[:args.limit]

    print(f'{len(feats)} stations · {len(cache)} already cached · {len(todo)} to fetch')
    if todo:
        print(f'at {DELAY}s/request this run takes about {len(todo) * DELAY / 60:.0f} min\n')

    ok = fail = 0
    for i, f in enumerate(todo, 1):
        sid = str(f['properties'].get('id'))
        name = f['properties'].get('name', '?')
        lon, lat = f['geometry']['coordinates']
        addr = reverse(lat, lon)
        if addr:
            cache[sid] = addr
            ok += 1
        else:
            fail += 1
        print(f'[{i}/{len(todo)}] {name}: {addr or "FAILED"}')
        if i % 25 == 0:
            save_cache(cache)  # checkpoint, so an interrupt loses at most 25
        if i < len(todo):
            time.sleep(DELAY)

    save_cache(cache)

    # Bake every address we hold into the GeoJSON the app ships.
    written = 0
    for f in feats:
        sid = str(f['properties'].get('id'))
        if cache.get(sid):
            f['properties']['address'] = cache[sid]
            written += 1
    with open(GEOJSON, 'w', encoding='utf-8') as fh:
        json.dump(geo, fh, ensure_ascii=False, separators=(',', ':'))

    print(f'\n{ok} fetched, {fail} failed this run')
    print(f'{written}/{len(feats)} stations now carry an address in the GeoJSON')
    missing = len(feats) - written
    if missing:
        print(f'{missing} still missing — re-run to retry (the cache means only those are fetched)')


if __name__ == '__main__':
    main()
