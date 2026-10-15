#!/usr/bin/env python3
"""
Pre-pairing tool for Guardian Weather App.
Queries local ngrok API (or takes a public URL), generates a secure, device-scoped
bearer token in the server database, and bakes the credentials directly into the Android
and PWA configurations.

The compiled APK will be pre-paired upon installation with zero manual setup.
"""
import argparse
import json
import os
import secrets
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "server" / "data" / "safety.db"
CONFIG_XML = ROOT / "android" / "app" / "src" / "main" / "res" / "values" / "prepaired_config.xml"
PWA_PREPAIR = ROOT / "server" / "pwa" / "prepaired.json"


def get_ngrok_url():
    """Query local ngrok API on port 4040."""
    try:
        r = urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=2)
        data = json.loads(r.read())
        tunnels = data.get("tunnels", [])
        if tunnels:
            # prefer https tunnel
            for t in tunnels:
                if t.get("public_url", "").startswith("https://"):
                    return t["public_url"].rstrip("/")
            return tunnels[0].get("public_url", "").rstrip("/")
    except Exception as e:
        print(f"Note: Could not reach ngrok API at http://127.0.0.1:4040/api/tunnels ({e})")
    return None


def register_prepaired_device(device_id, name, token):
    """Register device securely in safety.db with a dedicated restricted device token."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    # ensure devices table exists
    cur.execute("""
    CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT,
        first_seen REAL,
        last_seen REAL,
        watch INTEGER DEFAULT 1,
        online INTEGER DEFAULT 0,
        token TEXT,
        revoked INTEGER DEFAULT 0,
        kind TEXT
    )
    """)
    cols = {r[1] for r in cur.execute("PRAGMA table_info(devices)").fetchall()}
    if "kind" not in cols:
        cur.execute("ALTER TABLE devices ADD COLUMN kind TEXT")
        conn.commit()
    now = time.time()
    # insert or replace
    cur.execute("""
    INSERT INTO devices(id, name, first_seen, last_seen, watch, online, token, revoked, kind)
    VALUES (?, ?, ?, ?, 1, 0, ?, 0, 'phone')
    ON CONFLICT(id) DO UPDATE SET token=excluded.token, name=excluded.name, revoked=0
    """, (device_id, name, now, now, token))
    conn.commit()
    conn.close()
    print(f"Registered pre-paired device {device_id} in {DB_PATH}")


def write_android_config(server_url, device_id, token, name):
    CONFIG_XML.parent.mkdir(parents=True, exist_ok=True)
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="default_server_url" translatable="false">{server_url}</string>
    <string name="default_device_token" translatable="false">{token}</string>
    <string name="default_device_id" translatable="false">{device_id}</string>
    <string name="default_device_name" translatable="false">{name}</string>
</resources>
"""
    CONFIG_XML.write_text(xml)
    print(f"Wrote Android pre-paired config to {CONFIG_XML}")


def write_pwa_config(server_url, device_id, token, name):
    PWA_PREPAIR.parent.mkdir(parents=True, exist_ok=True)
    cfg = {
        "server": server_url,
        "token": token,
        "device_id": device_id,
        "name": name
    }
    PWA_PREPAIR.write_text(json.dumps(cfg, indent=2))
    print(f"Wrote PWA pre-paired config to {PWA_PREPAIR}")


def main():
    parser = argparse.ArgumentParser(description="Pre-pair Weather app with desktop client")
    parser.add_argument("--url", help="Public ngrok HTTPS URL (default: auto-detected from local ngrok API)")
    parser.add_argument("--name", default="My Weather Phone", help="Device name")
    args = parser.parse_args()

    server_url = args.url or get_ngrok_url()
    if not server_url:
        print("No ngrok URL found. Please specify --url https://your-ngrok-domain.dev or start ngrok.")
        sys.exit(1)

    device_id = "dev-" + secrets.token_hex(4)
    device_token = secrets.token_urlsafe(24)

    print(f"Desktop URL: {server_url}")
    print(f"Device ID:   {device_id}")
    print(f"Token:       {device_token[:8]}***")

    register_prepaired_device(device_id, args.name, device_token)
    write_android_config(server_url, device_id, device_token, args.name)
    write_pwa_config(server_url, device_id, device_token, args.name)

    print("\nPre-pairing complete! When the app installs, it is already paired and connected.")


if __name__ == "__main__":
    main()
