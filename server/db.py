"""SQLite storage for the safety server. Pure stdlib, no ORM."""
import sqlite3
import json
import math
import time
import threading
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(exist_ok=True)
FRAMES_DIR = DATA_DIR / "frames"
FRAMES_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "safety.db"

_local = threading.local()


def _conn() -> sqlite3.Connection:
    # One connection per thread. WAL so dashboard reads never block device writes.
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA busy_timeout=4000")
        _local.conn = c
    return c


SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id         TEXT PRIMARY KEY,
    name       TEXT,
    first_seen REAL,
    last_seen  REAL,
    watch      INTEGER DEFAULT 1,     -- 1 = watchdog armed (alert if it goes silent)
    online     INTEGER DEFAULT 0,
    token      TEXT,                  -- per-device token (null for legacy/admin-created)
    revoked    INTEGER DEFAULT 0,     -- 1 = token disabled; device can't post
    kind       TEXT                   -- phone | laptop (null = unknown, shown as phone)
);
CREATE TABLE IF NOT EXISTS pings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id  TEXT,
    ts         REAL,
    lat        REAL,
    lon        REAL,
    accuracy   REAL,
    speed      REAL,
    heading    REAL,
    battery    REAL,
    extra      TEXT
);
CREATE INDEX IF NOT EXISTS idx_pings_dev_ts ON pings(device_id, ts);
CREATE TABLE IF NOT EXISTS wifi (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ping_id   INTEGER,
    device_id TEXT,
    ts        REAL,
    ssid      TEXT,
    bssid     TEXT,
    rssi      INTEGER,
    open      INTEGER DEFAULT 0,
    capabilities TEXT
);
CREATE INDEX IF NOT EXISTS idx_wifi_bssid ON wifi(bssid);
CREATE TABLE IF NOT EXISTS bluetooth (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ping_id   INTEGER,
    device_id TEXT,
    ts        REAL,
    name      TEXT,
    address   TEXT,
    rssi      INTEGER,
    type      TEXT
);
CREATE INDEX IF NOT EXISTS idx_bt_dev_ts ON bluetooth(device_id, ts);
CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    ts        REAL,
    type      TEXT,       -- sos, geofence, offline, online, note, movement
    severity  TEXT,       -- info, warn, critical
    message   TEXT,
    data      TEXT,
    ack       INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS frames (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    ts        REAL,
    path      TEXT,
    kind      TEXT        -- sos, periodic, manual
);
CREATE TABLE IF NOT EXISTS geofences (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT,
    lat     REAL,
    lon     REAL,
    radius  REAL,
    kind    TEXT          -- safe | danger
);
CREATE TABLE IF NOT EXISTS places (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id  TEXT,
    name       TEXT,
    lat        REAL,
    lon        REAL,
    radius     REAL,
    kind       TEXT,       -- home | office | custom | auto
    visits     INTEGER DEFAULT 0,
    last_seen  REAL
);
CREATE INDEX IF NOT EXISTS idx_places_dev ON places(device_id);
CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT UNIQUE,
    created_at REAL,
    expires_at REAL,
    active     INTEGER DEFAULT 1
);
"""


def init():
    c = _conn()
    c.executescript(SCHEMA)
    # migrate older DBs that predate per-device tokens
    cols = {r[1] for r in c.execute("PRAGMA table_info(devices)").fetchall()}
    if "token" not in cols:
        c.execute("ALTER TABLE devices ADD COLUMN token TEXT")
    if "revoked" not in cols:
        c.execute("ALTER TABLE devices ADD COLUMN revoked INTEGER DEFAULT 0")
    if "kind" not in cols:
        c.execute("ALTER TABLE devices ADD COLUMN kind TEXT")
    if "places_cleared_at" not in cols:
        c.execute("ALTER TABLE devices ADD COLUMN places_cleared_at REAL DEFAULT 0")
    wifi_cols = {r[1] for r in c.execute("PRAGMA table_info(wifi)").fetchall()}
    if "open" not in wifi_cols:
        c.execute("ALTER TABLE wifi ADD COLUMN open INTEGER DEFAULT 0")
    if "capabilities" not in wifi_cols:
        c.execute("ALTER TABLE wifi ADD COLUMN capabilities TEXT")
    c.commit()


# ---- sessions ----
def init_session(token: str, duration_sec: float = 86400) -> dict:
    c = _conn()
    now = time.time()
    expires_at = now + duration_sec
    r = c.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
    if r:
        c.execute("UPDATE sessions SET expires_at=?, active=1 WHERE token=?", (expires_at, token))
    else:
        c.execute("INSERT INTO sessions(token, created_at, expires_at, active) VALUES(?,?,?,1)",
                  (token, now, expires_at))
    c.commit()
    return {"token": token, "created_at": now, "expires_at": expires_at, "active": 1}


def get_session(token: str) -> dict | None:
    if not token:
        return None
    r = _conn().execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
    return dict(r) if r else None


def is_session_active(token: str) -> bool:
    return True


def end_session(token: str):
    c = _conn()
    c.execute("UPDATE sessions SET active=0 WHERE token=?", (token,))
    c.commit()


def renew_session(token: str, duration_sec: float = 86400) -> dict:
    c = _conn()
    now = time.time()
    expires_at = now + duration_sec
    c.execute("UPDATE sessions SET expires_at=?, active=1 WHERE token=?", (expires_at, token))
    c.commit()
    return {"expires_at": expires_at, "active": 1, "remaining": duration_sec}



def device_by_token(token):
    """Return the device row for a valid, non-revoked device token, else None."""
    if not token:
        return None
    r = _conn().execute(
        "SELECT * FROM devices WHERE token=? AND COALESCE(revoked,0)=0", (token,)
    ).fetchone()
    return dict(r) if r else None


def create_paired_device(device_id, name, token, kind=None):
    c = _conn()
    now = time.time()
    c.execute(
        "INSERT INTO devices(id,name,first_seen,last_seen,watch,online,token,revoked,kind) "
        "VALUES(?,?,?,?,1,0,?,0,?)",
        (device_id, name, now, now, token, kind),
    )
    c.commit()


def set_device_kind(device_id, kind):
    c = _conn()
    c.execute("UPDATE devices SET kind=? WHERE id=?", (kind, device_id))
    c.commit()


def set_device_revoked(device_id, revoked):
    c = _conn()
    c.execute("UPDATE devices SET revoked=? WHERE id=?", (1 if revoked else 0, device_id))
    c.commit()


def touch_device(device_id: str, name: str | None = None):
    c = _conn()
    now = time.time()
    row = c.execute("SELECT id FROM devices WHERE id=?", (device_id,)).fetchone()
    if row is None:
        c.execute(
            "INSERT INTO devices(id,name,first_seen,last_seen,watch,online) VALUES(?,?,?,?,1,1)",
            (device_id, name or device_id, now, now),
        )
    else:
        if name:
            c.execute("UPDATE devices SET last_seen=?, online=1, name=? WHERE id=?",
                      (now, name, device_id))
        else:
            c.execute("UPDATE devices SET last_seen=?, online=1 WHERE id=?", (now, device_id))
    c.commit()


def add_ping(device_id, ts, lat, lon, accuracy, speed, heading, battery, extra, wifi_list, bluetooth_list=None):
    c = _conn()
    cur = c.execute(
        "INSERT INTO pings(device_id,ts,lat,lon,accuracy,speed,heading,battery,extra) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (device_id, ts, lat, lon, accuracy, speed, heading, battery,
         json.dumps(extra) if extra is not None else None),
    )
    ping_id = cur.lastrowid
    for w in (wifi_list or []):
        is_open = 1 if w.get("open") else 0
        c.execute(
            "INSERT INTO wifi(ping_id,device_id,ts,ssid,bssid,rssi,open,capabilities) VALUES(?,?,?,?,?,?,?,?)",
            (ping_id, device_id, ts, w.get("ssid"), (w.get("bssid") or "").lower() or None,
             w.get("rssi"), is_open, w.get("capabilities")),
        )
    for b in (bluetooth_list or []):
        c.execute(
            "INSERT INTO bluetooth(ping_id,device_id,ts,name,address,rssi,type) VALUES(?,?,?,?,?,?,?)",
            (ping_id, device_id, ts, b.get("name"), (b.get("address") or "").lower() or None,
             b.get("rssi"), b.get("type")),
        )
    c.commit()
    return ping_id


def add_event(device_id, type_, severity, message, data=None):
    c = _conn()
    ts = time.time()
    cur = c.execute(
        "INSERT INTO events(device_id,ts,type,severity,message,data) VALUES(?,?,?,?,?,?)",
        (device_id, ts, type_, severity, message, json.dumps(data) if data else None),
    )
    c.commit()
    prune_events()
    return {"id": cur.lastrowid, "device_id": device_id, "ts": ts, "type": type_,
            "severity": severity, "message": message, "data": data, "ack": 0}


def add_frame(device_id, ts, path, kind):
    c = _conn()
    cur = c.execute(
        "INSERT INTO frames(device_id,ts,path,kind) VALUES(?,?,?,?)",
        (device_id, ts, path, kind),
    )
    c.commit()
    return cur.lastrowid


def ack_event(event_id):
    c = _conn()
    c.execute("UPDATE events SET ack=1 WHERE id=?", (event_id,))
    c.commit()


# ---- geofences ----
def list_geofences():
    return [dict(r) for r in _conn().execute("SELECT * FROM geofences ORDER BY id").fetchall()]


def add_geofence(name, lat, lon, radius, kind):
    c = _conn()
    cur = c.execute(
        "INSERT INTO geofences(name,lat,lon,radius,kind) VALUES(?,?,?,?,?)",
        (name, lat, lon, radius, kind),
    )
    c.commit()
    return cur.lastrowid


def delete_geofence(gid):
    c = _conn()
    c.execute("DELETE FROM geofences WHERE id=?", (gid,))
    c.commit()


def clear_geofences(kind=None):
    c = _conn()
    if kind:
        c.execute("DELETE FROM geofences WHERE kind=?", (kind,))
    else:
        c.execute("DELETE FROM geofences")
    c.commit()


# ---- places (home / office / learned) ----
def list_places(device_id=None):
    if device_id:
        rows = _conn().execute(
            "SELECT * FROM places WHERE device_id=? ORDER BY visits DESC", (device_id,)).fetchall()
    else:
        rows = _conn().execute("SELECT * FROM places ORDER BY visits DESC").fetchall()
    return [dict(r) for r in rows]


def add_place(device_id, name, lat, lon, radius, kind):
    c = _conn()
    cur = c.execute(
        "INSERT INTO places(device_id,name,lat,lon,radius,kind,visits,last_seen) "
        "VALUES(?,?,?,?,?,?,0,?)",
        (device_id, name, float(lat), float(lon), float(radius), kind, time.time()))
    c.commit()
    return cur.lastrowid


def rename_place(place_id, name, kind=None):
    c = _conn()
    if kind:
        c.execute("UPDATE places SET name=?, kind=? WHERE id=?", (name, kind, place_id))
    else:
        c.execute("UPDATE places SET name=? WHERE id=?", (name, place_id))
    c.commit()


def delete_place(place_id):
    c = _conn()
    c.execute("DELETE FROM places WHERE id=?", (place_id,))
    c.commit()


def clear_places(device_id=None):
    """Clear learned / most-visited places for a specific device, or all devices if None."""
    c = _conn()
    now = time.time()
    if device_id:
        c.execute("DELETE FROM places WHERE device_id=?", (device_id,))
        c.execute("UPDATE devices SET places_cleared_at=? WHERE id=?", (now, device_id))
    else:
        c.execute("DELETE FROM places")
        c.execute("UPDATE devices SET places_cleared_at=?", (now,))
    c.commit()


def bump_place_visit(place_id):
    c = _conn()
    c.execute("UPDATE places SET visits=visits+1, last_seen=? WHERE id=?", (time.time(), place_id))
    c.commit()


def frequent_clusters(device_id, cell_m=120, min_count=10, limit=8, lookback=3000):
    """Bucket recent pings onto a ~cell_m grid; return busy cells as candidate places."""
    rows = _conn().execute(
        "SELECT lat,lon FROM pings WHERE device_id=? AND lat IS NOT NULL "
        "ORDER BY ts DESC LIMIT ?", (device_id, lookback)).fetchall()
    deg = cell_m / 111000.0
    buckets = {}
    for r in rows:
        key = (round(r["lat"] / deg), round(r["lon"] / deg))
        b = buckets.setdefault(key, [0, 0.0, 0.0])
        b[0] += 1; b[1] += r["lat"]; b[2] += r["lon"]
    out = [{"lat": b[1] / b[0], "lon": b[2] / b[0], "count": b[0]}
           for b in buckets.values() if b[0] >= min_count]
    out.sort(key=lambda x: -x["count"])
    return out[:limit]


def add_geofences_bulk(items):
    """items: iterable of (name, lat, lon, radius, kind). Returns count."""
    c = _conn()
    n = 0
    for name, lat, lon, radius, kind in items:
        c.execute(
            "INSERT INTO geofences(name,lat,lon,radius,kind) VALUES(?,?,?,?,?)",
            (name, float(lat), float(lon), float(radius), kind),
        )
        n += 1
    c.commit()
    return n


# ---- reads for dashboard ----
def list_devices():
    out = []
    for r in _conn().execute("SELECT * FROM devices ORDER BY last_seen DESC").fetchall():
        d = dict(r)
        d.pop("token", None)   # never expose per-device tokens in listings
        out.append(d)
    return out


def last_ping(device_id):
    r = _conn().execute(
        "SELECT * FROM pings WHERE device_id=? ORDER BY ts DESC LIMIT 1", (device_id,)
    ).fetchone()
    return dict(r) if r else None


def last_fix(device_id):
    """Most recent ping that actually had a position (a ping can be battery-only)."""
    r = _conn().execute(
        "SELECT ts,lat,lon,accuracy,speed,heading,extra FROM pings "
        "WHERE device_id=? AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1", (device_id,)
    ).fetchone()
    if not r:
        return None
    d = dict(r)
    try:
        d["extra"] = json.loads(d["extra"]) if d["extra"] else None
    except Exception:
        d["extra"] = None
    return d


def locate_from_wifi(bssids, exclude_device, max_age_s=60 * 86400):
    """Personal WiFi map: estimate a position from access points that *other* devices
    (phones with GPS) have seen while they had a good fix. Returns {lat,lon,accuracy}
    or None. Lets a laptop with no GPS borrow the phone's history of where it's been."""
    bssids = [b.lower() for b in bssids if b][:20]
    if not bssids:
        return None
    rows = _conn().execute(
        f"SELECT w.bssid, w.rssi, p.lat, p.lon FROM wifi w JOIN pings p ON p.id = w.ping_id "
        f"WHERE w.bssid IN ({','.join('?' * len(bssids))}) AND w.device_id != ? "
        f"AND p.lat IS NOT NULL AND COALESCE(p.accuracy, 999) <= 60 AND w.ts > ? "
        f"ORDER BY w.ts DESC LIMIT 600",
        (*bssids, exclude_device, time.time() - max_age_s)).fetchall()
    if len(rows) < 2:
        return None
    # weight each sighting by how strongly the phone heard that AP (closer = stronger)
    ws = [max(1.0, (r["rssi"] if r["rssi"] is not None else -90) + 100.0) for r in rows]
    tot = sum(ws)
    lat = sum(w * r["lat"] for w, r in zip(ws, rows)) / tot
    lon = sum(w * r["lon"] for w, r in zip(ws, rows)) / tot
    deg_m = 111000.0
    spread = (sum(w * (((r["lat"] - lat) * deg_m) ** 2 + ((r["lon"] - lon) * deg_m *
              math.cos(math.radians(lat))) ** 2) for w, r in zip(ws, rows)) / tot) ** 0.5
    return {"lat": lat, "lon": lon, "accuracy": round(min(max(spread, 25.0), 500.0))}


def prune_pings():
    """Retain location pings and signal history strictly up to the last 3 days."""
    c = _conn()
    now = time.time()
    cutoff = now - 3 * 86400  # 3 days
    c.execute("DELETE FROM wifi WHERE ts < ?", (cutoff,))
    c.execute("DELETE FROM bluetooth WHERE ts < ?", (cutoff,))
    c.execute("DELETE FROM pings WHERE ts < ?", (cutoff,))
    c.commit()


def track(device_id, limit=400):
    prune_pings()
    cutoff = time.time() - 3 * 86400
    rows = _conn().execute(
        "SELECT ts,lat,lon,accuracy,speed,heading,battery FROM pings WHERE device_id=? AND ts >= ? "
        "ORDER BY ts DESC LIMIT ?", (device_id, cutoff, limit)
    ).fetchall()
    return [dict(r) for r in rows][::-1]


def clear_track(device_id=None):
    """Clear path history for a specific device, or all devices if None, preserving the latest position fix."""
    c = _conn()
    if device_id:
        row = c.execute(
            "SELECT id FROM pings WHERE device_id=? AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1",
            (device_id,)
        ).fetchone()
        latest_id = row[0] if row else None
        if latest_id:
            c.execute("DELETE FROM wifi WHERE ping_id IN (SELECT id FROM pings WHERE device_id=? AND id != ?)", (device_id, latest_id))
            c.execute("DELETE FROM bluetooth WHERE ping_id IN (SELECT id FROM pings WHERE device_id=? AND id != ?)", (device_id, latest_id))
            c.execute("DELETE FROM pings WHERE device_id=? AND id != ?", (device_id, latest_id))
        else:
            c.execute("DELETE FROM wifi WHERE ping_id IN (SELECT id FROM pings WHERE device_id=?)", (device_id,))
            c.execute("DELETE FROM bluetooth WHERE ping_id IN (SELECT id FROM pings WHERE device_id=?)", (device_id,))
            c.execute("DELETE FROM pings WHERE device_id=?", (device_id,))
    else:
        devs = [r[0] for r in c.execute("SELECT DISTINCT device_id FROM pings WHERE lat IS NOT NULL").fetchall()]
        keep_ids = []
        for dev in devs:
            row = c.execute("SELECT id FROM pings WHERE device_id=? AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1", (dev,)).fetchone()
            if row:
                keep_ids.append(row[0])
        if keep_ids:
            placeholders = ",".join("?" for _ in keep_ids)
            c.execute(f"DELETE FROM wifi WHERE ping_id NOT IN ({placeholders})", keep_ids)
            c.execute(f"DELETE FROM bluetooth WHERE ping_id NOT IN ({placeholders})", keep_ids)
            c.execute(f"DELETE FROM pings WHERE id NOT IN ({placeholders})", keep_ids)
        else:
            c.execute("DELETE FROM wifi")
            c.execute("DELETE FROM bluetooth")
            c.execute("DELETE FROM pings")
    c.commit()


def prune_events():
    """Retain activity logs only up to the last 3 days or 3 MB, whichever limit is hit first."""
    c = _conn()
    now = time.time()
    cutoff = now - 3 * 86400  # 3 days
    # 1. Delete events older than 3 days
    c.execute("DELETE FROM events WHERE ts < ?", (cutoff,))

    # 2. Check total size of events table; cap at 3 MB
    max_bytes = 3 * 1024 * 1024  # 3 MB
    total_bytes = c.execute(
        "SELECT SUM(LENGTH(message) + COALESCE(LENGTH(data), 0) + 64) FROM events"
    ).fetchone()[0] or 0

    if total_bytes > max_bytes:
        # Delete oldest events in chunks until under limit
        c.execute("""
            DELETE FROM events WHERE id IN (
                SELECT id FROM events ORDER BY ts ASC LIMIT 200
            )
        """)
    c.commit()


def recent_events(limit=500):
    prune_events()
    cutoff = time.time() - 3 * 86400
    rows = _conn().execute(
        "SELECT * FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?", (cutoff, limit)
    ).fetchall()
    out = []
    total_bytes = 0
    max_bytes = 3 * 1024 * 1024  # 3 MB
    for r in rows:
        d = dict(r)
        if d.get("data"):
            try:
                d["data"] = json.loads(d["data"])
            except Exception:
                pass
        item_size = len(d.get("message") or "") + len(str(d.get("data") or "")) + 64
        if total_bytes + item_size > max_bytes:
            break
        total_bytes += item_size
        out.append(d)
    return out


def recent_frames(device_id=None, limit=12):
    if device_id:
        rows = _conn().execute(
            "SELECT * FROM frames WHERE device_id=? ORDER BY ts DESC LIMIT ?",
            (device_id, limit)).fetchall()
    else:
        rows = _conn().execute(
            "SELECT * FROM frames ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def last_wifi(device_id, limit=20):
    rows = _conn().execute(
        "SELECT ssid,bssid,rssi,open,capabilities,ts FROM wifi WHERE device_id=? ORDER BY ts DESC LIMIT ?",
        (device_id, limit)).fetchall()
    return [dict(r) for r in rows]


def last_bluetooth(device_id, limit=20):
    rows = _conn().execute(
        "SELECT name,address,rssi,type,ts FROM bluetooth WHERE device_id=? ORDER BY ts DESC LIMIT ?",
        (device_id, limit)).fetchall()
    return [dict(r) for r in rows]


def devices_to_mark_offline(timeout_s: float):
    now = time.time()
    rows = _conn().execute(
        "SELECT id,name,last_seen FROM devices WHERE online=1 AND last_seen < ?",
        (now - timeout_s,)).fetchall()
    return [dict(r) for r in rows]


def set_offline(device_id):
    c = _conn()
    c.execute("UPDATE devices SET online=0 WHERE id=?", (device_id,))
    c.commit()
