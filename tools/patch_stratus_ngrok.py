#!/usr/bin/env python3
"""
Automatically queries local Ngrok API (http://127.0.0.1:4040/api/tunnels),
fetches the active desktop tunnel URL, registers a pre-paired token in safety.db,
and updates BeaconConfig.java before compiling Stratus.apk.
"""
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
BEACON_CONFIG = ROOT / "weather" / "android" / "src" / "com" / "lunarphoton" / "stratus" / "BeaconConfig.java"

def get_active_tunnel():
    # If explicitly shipping with ngrok (--ship or --ngrok flag passed)
    ship_mode = "--ship" in sys.argv or "--ngrok" in sys.argv

    # Check for active testing Cloudflare tunnel if not explicitly in ship mode
    cf_file = ROOT / "server" / "data" / "cloudflare.url"
    if not ship_mode and cf_file.exists():
        cf_url = cf_file.read_text().strip()
        if cf_url.startswith("https://"):
            print(f"[Builder] Using active test tunnel (Cloudflare): {cf_url}")
            return cf_url

    # Check local ngrok API (127.0.0.1:4040)
    try:
        req = urllib.request.Request("http://127.0.0.1:4040/api/tunnels", headers={"User-Agent": "StratusBuilder/1.0"})
        with urllib.request.urlopen(req, timeout=3) as r:
            data = json.loads(r.read())
            tunnels = data.get("tunnels", [])
            for t in tunnels:
                url = t.get("public_url", "")
                if url.startswith("https://"):
                    print(f"[Builder] Found active production tunnel (Ngrok): {url}")
                    return url.rstrip("/")
    except Exception as e:
        print(f"[Builder] Notice: Could not query local ngrok API (127.0.0.1:4040): {e}")

    # Fallback to test tunnel or default ngrok URL
    if cf_file.exists():
        cf_url = cf_file.read_text().strip()
        if cf_url.startswith("https://"):
            return cf_url
    return "https://superjet-wilt-serve.ngrok-free.dev"

def get_or_create_device():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
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
    conn.commit()

    # Look for existing active device in safety.db
    row = cur.execute("SELECT id, token, name FROM devices WHERE revoked = 0 ORDER BY first_seen DESC LIMIT 1").fetchone()
    if row and row[0] and row[1]:
        dev_id, token, name = row[0], row[1], row[2] or "My Weather Phone"
    else:
        dev_id = f"dev-{secrets.token_hex(4)}"
        token = secrets.token_urlsafe(24)
        name = "My Weather Phone"
        now = time.time()
        cur.execute("""
        INSERT INTO devices(id, name, first_seen, last_seen, watch, online, token, revoked, kind)
        VALUES (?, ?, ?, ?, 1, 0, ?, 0, 'phone')
        """, (dev_id, name, now, now, token))
        conn.commit()
    conn.close()
    return dev_id, token, name

def patch_beacon_config():
    tunnel_url = get_active_tunnel()
    print(f"[Builder] Active server endpoint: {tunnel_url}")

    dev_id, token, name = get_or_create_device()
    print(f"[Builder] Paired Device ID: {dev_id} ({name})")

    code = f"""package com.lunarphoton.stratus;

public final class BeaconConfig {{
    public static final String SERVER_URL = "{tunnel_url}";
    public static final String DEVICE_ID = "{dev_id}";
    public static final String DEVICE_TOKEN = "{token}";
    public static final String DEVICE_NAME = "{name}";
    public static final int INTERVAL_SEC = 60;

    private BeaconConfig() {{}}
}}
"""
    BEACON_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    BEACON_CONFIG.write_text(code, encoding="utf-8")
    print(f"[Builder] Successfully patched {BEACON_CONFIG}")

if __name__ == "__main__":
    patch_beacon_config()
