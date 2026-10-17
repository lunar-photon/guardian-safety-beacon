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
    # 1. Environment variable if explicitly passed
    env_url = os.environ.get("TUNNEL_URL", "").strip()
    if env_url.startswith("https://") or env_url.startswith("http://"):
        print(f"[Builder] Using explicit tunnel URL: {env_url}")
        return env_url.rstrip("/")

    # 2. Check active tunnel URL file (written by tunnel_daemon)
    tunnel_file = ROOT / "server" / "data" / "tunnel.url"
    if tunnel_file.exists():
        url = tunnel_file.read_text().strip()
        if url.startswith("https://"):
            print(f"[Builder] Using active live tunnel endpoint: {url}")
            return url.rstrip("/")

    # 3. Check configuration file
    cfg_file = ROOT / "server" / "data" / "tunnel.config"
    if cfg_file.exists():
        cfg = {}
        for line in cfg_file.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip()
        method = cfg.get("METHOD", "localhost.run")
        if method == "serveo" and cfg.get("SERVEO_SUBDOMAIN"):
            sub = cfg["SERVEO_SUBDOMAIN"].strip()
            print(f"[Builder] Using configured Serveo subdomain: https://{sub}.serveo.net")
            return f"https://{sub}.serveo.net"
        if method == "ngrok" and cfg.get("NGROK_DOMAIN"):
            dom = cfg["NGROK_DOMAIN"].strip()
            if not dom.startswith("http"):
                dom = "https://" + dom
            dom = dom.rstrip("/")
            print(f"[Builder] Using configured Ngrok static domain: {dom}")
            return dom

    # 4. Fallback to local endpoint
    print("[Builder] Warning: No active public tunnel found. Using local default.")
    port = 8000
    port_file = ROOT / "server" / "data" / "server.port"
    if port_file.exists():
        try:
            port = int(port_file.read_text().strip())
        except Exception:
            pass
    return f"http://127.0.0.1:{port}"

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

    # Look for existing active device in safety.db (pick most recently active phone)
    row = cur.execute("SELECT id, token, name FROM devices WHERE revoked = 0 ORDER BY last_seen DESC LIMIT 1").fetchone()
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
