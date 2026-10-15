#!/usr/bin/env python3
"""
Import a CSV of unsafe-area hotspots into the Guardian server as DANGER zones.
Phones then warn you when you get near one.

CSV columns (header row required):
    name,lat,lon,radius,severity
  - name     : label shown on the map (e.g. "MG Road underpass")
  - lat,lon  : decimal degrees (required)
  - radius   : metres; optional (defaults to the server's PROXIMITY_WARN_M)
  - severity : optional number/text, only used to decorate the name

Usage:
    python ingest_hotspots.py --server http://localhost:8000 --token YOUR_TOKEN \
        --csv ../data_sources/sample_hotspots.csv --replace

--replace wipes existing DANGER zones first (so re-imports don't pile up).
Stdlib only; no pip installs needed.

Where to get real data (see data_sources/README.md for details and links):
  * NCRB "Crime in India" district tables -> join district names to district
    centroids (a districts shapefile/centroid CSV) to get lat/lon.
  * Local police "dark spot" / safety-audit lists (many city police publish these).
  * Safecity map pins (manual, no public API).
  * Or just mark spots you personally know are unsafe.
NOTE: NCRB data is district-level and annual. Treat imported zones as a coarse
"be more alert here" signal, not a precise real-time danger map.
"""
import argparse
import csv
import json
import sys
import urllib.request


def load_rows(path):
    items = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader, 2):
            try:
                lat = float(row["lat"]); lon = float(row["lon"])
            except (KeyError, ValueError):
                print(f"  skip line {i}: bad/missing lat/lon", file=sys.stderr)
                continue
            name = (row.get("name") or "hotspot").strip()
            sev = (row.get("severity") or "").strip()
            if sev:
                name = f"{name} [{sev}]"
            item = {"name": name, "lat": lat, "lon": lon, "kind": "danger"}
            if row.get("radius"):
                try:
                    item["radius"] = float(row["radius"])
                except ValueError:
                    pass
            items.append(item)
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True, help="e.g. http://localhost:8000")
    ap.add_argument("--token", required=True)
    ap.add_argument("--csv", required=True)
    ap.add_argument("--replace", action="store_true",
                    help="remove existing danger zones before importing")
    args = ap.parse_args()

    items = load_rows(args.csv)
    if not items:
        print("No valid rows found.", file=sys.stderr)
        sys.exit(1)

    body = {"items": items}
    if args.replace:
        body["replace_kind"] = "danger"

    req = urllib.request.Request(
        args.server.rstrip("/") + "/api/geofence/bulk",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + args.token},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            resp = json.loads(r.read())
        print(f"Imported {resp.get('added')} danger zone(s) "
              f"({'replaced existing' if args.replace else 'appended'}).")
    except urllib.error.HTTPError as e:
        print(f"Server error {e.code}: {e.read().decode(errors='ignore')}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
