"""SQLite storage for the safety server. Pure stdlib, no ORM."""
import sqlite3
import json
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
    online     INTEGER DEFAULT 0
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
    rssi      INTEGER
);
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
"""


def init():
    c = _conn()
    c.executescript(SCHEMA)
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


def add_ping(device_id, ts, lat, lon, accuracy, speed, heading, battery, extra, wifi_list):
    c = _conn()
    cur = c.execute(
        "INSERT INTO pings(device_id,ts,lat,lon,accuracy,speed,heading,battery,extra) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (device_id, ts, lat, lon, accuracy, speed, heading, battery,
         json.dumps(extra) if extra is not None else None),
    )
    ping_id = cur.lastrowid
    for w in (wifi_list or []):
        c.execute(
            "INSERT INTO wifi(ping_id,device_id,ts,ssid,bssid,rssi) VALUES(?,?,?,?,?,?)",
            (ping_id, device_id, ts, w.get("ssid"), w.get("bssid"), w.get("rssi")),
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
    return [dict(r) for r in _conn().execute("SELECT * FROM devices ORDER BY last_seen DESC").fetchall()]


def last_ping(device_id):
    r = _conn().execute(
        "SELECT * FROM pings WHERE device_id=? ORDER BY ts DESC LIMIT 1", (device_id,)
    ).fetchone()
    return dict(r) if r else None


def track(device_id, limit=200):
    rows = _conn().execute(
        "SELECT ts,lat,lon,accuracy,speed,battery FROM pings WHERE device_id=? "
        "ORDER BY ts DESC LIMIT ?", (device_id, limit)
    ).fetchall()
    return [dict(r) for r in rows][::-1]


def recent_events(limit=100):
    rows = _conn().execute(
        "SELECT * FROM events ORDER BY ts DESC LIMIT ?", (limit,)
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        if d.get("data"):
            try:
                d["data"] = json.loads(d["data"])
            except Exception:
                pass
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
        "SELECT ssid,bssid,rssi,ts FROM wifi WHERE device_id=? ORDER BY ts DESC LIMIT ?",
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
