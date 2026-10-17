"""
Guardian safety server.

Receives GPS / WiFi / webcam / SOS from your own phone (PWA or the Android app),
logs everything to SQLite, and serves a live dashboard with a map, timeline,
webcam frames and geofence/SOS/offline alerts.

Run:
    pip install -r requirements.txt
    SAFETY_TOKEN=pick-a-long-secret python app.py
Then expose to your phone:
    ngrok http 8000

Auth: every device request and the dashboard must send the shared token
(Authorization: Bearer <token>, or ?token= for the websocket / image tags).
This is a family protection system where one server acts as a Guardian Angel for family members' devices.
"""
import os
import time
import json
import base64
import socket
import asyncio
import secrets
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException, Depends
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

import db

TOKEN = os.environ.get("SAFETY_TOKEN", "")
if not TOKEN:
    TOKEN = secrets.token_urlsafe(18)
    print("\n" + "=" * 64)
    print("  No SAFETY_TOKEN set. Generated one for this run:")
    print("     " + TOKEN)
    print("  Set SAFETY_TOKEN in the environment to keep it stable.")
    print("=" * 64 + "\n")

OFFLINE_TIMEOUT = float(os.environ.get("OFFLINE_TIMEOUT", "180"))   # seconds of silence -> alert
PROXIMITY_WARN_M = float(os.environ.get("PROXIMITY_WARN_M", "300"))  # warn when this close to a danger zone
HERE = Path(__file__).resolve().parent


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def resolve_port() -> int:
    env_port = os.environ.get("PORT")
    if env_port and env_port.strip():
        try:
            p = int(env_port.strip())
            if p > 0:
                return p
        except ValueError:
            pass
    port_file = HERE / "data" / "server.port"
    if port_file.exists():
        try:
            p = int(port_file.read_text().strip())
            if p > 0:
                return p
        except ValueError:
            pass
    return get_free_port()


PORT = resolve_port()
try:
    (HERE / "data").mkdir(parents=True, exist_ok=True)
    (HERE / "data" / "server.port").write_text(str(PORT))
except Exception:
    pass


def lan_ip() -> str:
    """Best-effort local network IP so the phone can reach us on the same WiFi."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))     # no packets sent; just picks the outbound iface
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()

# India emergency / women-safety helplines. Served to clients so numbers live in one place.
HELPLINES = [
    {"label": "Emergency (112)", "number": "112"},
    {"label": "Women Helpline (1091)", "number": "1091"},
    {"label": "Women / Domestic (181)", "number": "181"},
]

DEVICE_KINDS = {"phone", "laptop"}

app = FastAPI(title="Guardian")


# ----------------------------------------------------------------------------
# auth
# ----------------------------------------------------------------------------
def _extract_token(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    tok = request.query_params.get("token", "")
    if tok:
        return tok
    tok = request.cookies.get("guardian_token", "")
    if tok:
        return tok
    # Local loopback callers on localhost / 127.0.0.1 are trusted
    host = request.url.hostname or ""
    client_host = request.client.host if request.client else ""
    if host in ("localhost", "127.0.0.1", "::1") or client_host in ("127.0.0.1", "::1"):
        return TOKEN
    return ""


class Principal:
    """Who is calling: the admin (master token) or a specific paired device."""
    def __init__(self, admin: bool, device_id: str | None = None):
        self.admin = admin
        self.device_id = device_id


def _is_master(token: str) -> bool:
    return bool(token) and secrets.compare_digest(token, TOKEN)


def require_admin(request: Request) -> Principal:
    """Dashboard / operator endpoints — master token only."""
    if not _is_master(_extract_token(request)):
        raise HTTPException(status_code=401, detail="admin token required")
    return Principal(admin=True)


def require_admin_renew(request: Request) -> Principal:
    """Allow master token to renew tracking session."""
    if not _is_master(_extract_token(request)):
        raise HTTPException(status_code=401, detail="admin token required")
    return Principal(admin=True)


def require_principal(request: Request) -> Principal:
    """Device-or-admin endpoints. A device token only authenticates that device."""
    tok = _extract_token(request)
    if _is_master(tok):
        return Principal(admin=True)
    dev = db.device_by_token(tok)
    if dev:
        return Principal(admin=False, device_id=dev["id"])
    raise HTTPException(status_code=401, detail="bad or revoked token")


# Back-compat alias: existing admin endpoints use this name.
require_token = require_admin


# ----------------------------------------------------------------------------
# websocket hub -> pushes live updates to every open dashboard
# ----------------------------------------------------------------------------
class Hub:
    def __init__(self):
        self.clients: set[WebSocket] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    async def join(self, ws: WebSocket):
        await ws.accept()
        self.clients.add(ws)

    def leave(self, ws: WebSocket):
        self.clients.discard(ws)

    async def _send(self, payload: dict):
        dead = []
        data = json.dumps(payload)
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def broadcast(self, payload: dict):
        """Thread-safe: callable from request handlers."""
        if self.loop is None:
            return
        asyncio.run_coroutine_threadsafe(self._send(payload), self.loop)


hub = Hub()


# ----------------------------------------------------------------------------
# geofence logic
# ----------------------------------------------------------------------------
def _haversine_m(lat1, lon1, lat2, lon2):
    from math import radians, sin, cos, asin, sqrt
    r = 6371000.0
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 2 * r * asin(sqrt(a))


# remember the last zone-state per device so we only fire on transitions
_zone_state: dict[str, dict[int, bool]] = {}
_place_state: dict[str, dict[int, bool]] = {}


def check_places(device_id, lat, lon):
    """Log 'Reached <place>' / 'Left <place>' when a device enters/leaves a known place."""
    places = db.list_places(device_id)
    state = _place_state.setdefault(device_id, {})
    for p in places:
        inside = _haversine_m(lat, lon, p["lat"], p["lon"]) <= (p["radius"] or 120)
        was = state.get(p["id"])
        state[p["id"]] = inside
        if was is None:
            if inside:
                db.bump_place_visit(p["id"])
            continue
        if inside and not was:
            db.bump_place_visit(p["id"])
            ev = db.add_event(device_id, "arrival", "info",
                              f"Reached {p['name']}", {"place": p["name"], "kind": p["kind"]})
            hub.broadcast({"kind": "event", "event": ev})
        elif was and not inside:
            ev = db.add_event(device_id, "departure", "info",
                              f"Left {p['name']}", {"place": p["name"], "kind": p["kind"]})
            hub.broadcast({"kind": "event", "event": ev})


def auto_learn_places(device_id):
    """Turn frequently-visited clusters into 'auto' places (named later by the user)."""
    existing = db.list_places(device_id)
    created = 0
    for c in db.frequent_clusters(device_id):
        near = any(_haversine_m(c["lat"], c["lon"], p["lat"], p["lon"]) < 150 for p in existing)
        if near:
            continue
        n = sum(1 for p in existing if p["kind"] == "auto") + created + 1
        db.add_place(device_id, f"Frequent place {n}", c["lat"], c["lon"], 120, "auto")
        created += 1
    if created:
        _place_state.pop(device_id, None)  # recompute transitions against new places
        hub.broadcast({"kind": "refresh"})
    return created


_danger_dwell: dict[str, dict[int, dict]] = {}
STUCK_DANGER_TIMEOUT_S = float(os.environ.get("STUCK_DANGER_TIMEOUT_S", "120"))  # seconds stationary in danger zone -> helpline outreach
HELPLINE_PRIMARY = os.environ.get("HELPLINE_PRIMARY", "112")
HELPLINE_WEBHOOK_URL = os.environ.get("HELPLINE_WEBHOOK_URL", "")


def dispatch_helpline_alert(device_id: str, name: str, lat: float, lon: float, accuracy: float, zone_name: str, dwell_s: float):
    dev_name = name or device_id
    maps_url = f"https://maps.google.com/?q={lat:.6f},{lon:.6f}"
    dwell_min = int(dwell_s // 60)
    dwell_txt = f"{dwell_min}m" if dwell_min > 0 else f"{int(dwell_s)}s"

    msg = (f"EMERGENCY: Phone '{dev_name}' is STUCK at suspicious location '{zone_name}' "
           f"({dwell_txt} stationary). Reaching out to helpline ({HELPLINE_PRIMARY}) with coordinates: "
           f"{lat:.5f}, {lon:.5f}. Live Map: {maps_url}")

    # 1. Log critical event in database
    ev = db.add_event(
        device_id, "helpline", "critical", msg,
        {
            "zone": zone_name,
            "lat": lat,
            "lon": lon,
            "accuracy": accuracy,
            "dwell_s": dwell_s,
            "maps_url": maps_url,
            "helpline": HELPLINE_PRIMARY,
            "dispatched": True,
        }
    )

    # 2. Enqueue emergency commands for the phone (immediate response)
    _commands.setdefault(device_id, []).append({
        "cmd": "emergency_helpline",
        "args": {
            "number": HELPLINE_PRIMARY,
            "zone": zone_name,
            "lat": lat,
            "lon": lon,
            "message": f"EMERGENCY: Stuck at {zone_name}. Coordinates: {lat:.5f}, {lon:.5f}. Map: {maps_url}"
        }
    })
    _commands.setdefault(device_id, []).append({
        "cmd": "snap",
        "args": {"camera": "both"}
    })

    # 3. Log persistent dispatch audit record
    try:
        dispatch_log = HERE / "data" / "helpline_dispatches.log"
        dispatch_entry = {
            "ts": time.time(),
            "time_iso": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
            "device_id": device_id,
            "name": dev_name,
            "zone": zone_name,
            "lat": lat,
            "lon": lon,
            "dwell_seconds": dwell_s,
            "helpline": HELPLINE_PRIMARY,
            "maps_url": maps_url,
        }
        with open(dispatch_log, "a", encoding="utf-8") as f:
            f.write(json.dumps(dispatch_entry) + "\n")
    except Exception as e:
        print(f"[Helpline] Error logging dispatch: {e}")

    # 4. Webhook dispatch if configured
    webhook_url = HELPLINE_WEBHOOK_URL
    if not webhook_url and (HERE / "data" / "helpline_webhook.url").exists():
        webhook_url = (HERE / "data" / "helpline_webhook.url").read_text().strip()

    if webhook_url:
        try:
            import urllib.request
            req = urllib.request.Request(
                webhook_url,
                data=json.dumps(dispatch_entry).encode("utf-8"),
                headers={"Content-Type": "application/json", "User-Agent": "Guardian-Helpline-Dispatcher/1.0"}
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            print(f"[Helpline] Webhook dispatch error: {e}")

    # 5. Broadcast alert to all connected Guardian Angel dashboards over WebSocket
    hub.broadcast({
        "kind": "helpline_alert",
        "device_id": device_id,
        "name": dev_name,
        "zone": zone_name,
        "lat": lat,
        "lon": lon,
        "dwell_s": dwell_s,
        "maps_url": maps_url,
        "helpline": HELPLINE_PRIMARY,
        "event": ev
    })
    hub.broadcast({"kind": "event", "event": ev})


def check_geofences(device_id, lat, lon, speed=None, accuracy=None, name=None):
    fences = list(db.list_geofences())
    for p in db.list_places(device_id):
        if p.get("kind") == "danger" and not any(f.get("kind") == "danger" and _haversine_m(p["lat"], p["lon"], f["lat"], f["lon"]) < 40 for f in fences):
            fences.append({
                "id": f"place_{p['id']}",
                "name": p["name"],
                "lat": p["lat"],
                "lon": p["lon"],
                "radius": p.get("radius") or 250,
                "kind": "danger"
            })
    state = _zone_state.setdefault(device_id, {})
    dwell_map = _danger_dwell.setdefault(device_id, {})
    now = time.time()

    for f in fences:
        inside = _haversine_m(lat, lon, f["lat"], f["lon"]) <= f["radius"]
        was = state.get(f["id"])
        state[f["id"]] = inside

        if f["kind"] == "danger":
            if inside:
                if f["id"] not in dwell_map:
                    dwell_map[f["id"]] = {
                        "first_seen": now,
                        "last_seen": now,
                        "entry_lat": lat,
                        "entry_lon": lon,
                        "last_lat": lat,
                        "last_lon": lon,
                        "alerted": False
                    }
                else:
                    entry = dwell_map[f["id"]]
                    entry["last_seen"] = now
                    entry["last_lat"] = lat
                    entry["last_lon"] = lon

                    dwell_s = now - entry["first_seen"]
                    dist_moved = _haversine_m(lat, lon, entry["entry_lat"], entry["entry_lon"])
                    # Stationary criteria: speed < 1.0 m/s or distance moved < 40 meters
                    is_stationary = (speed is None or speed < 1.0) or (dist_moved < 40.0)

                    if dwell_s >= STUCK_DANGER_TIMEOUT_S and is_stationary and not entry["alerted"]:
                        entry["alerted"] = True
                        dispatch_helpline_alert(
                            device_id=device_id,
                            name=name,
                            lat=lat,
                            lon=lon,
                            accuracy=accuracy,
                            zone_name=f["name"],
                            dwell_s=dwell_s
                        )
            else:
                dwell_map.pop(f["id"], None)

        if was is None:
            continue  # first sighting, don't alert

        if f["kind"] == "danger" and inside and not was:
            ev = db.add_event(device_id, "geofence", "critical",
                              f"Entered DANGER zone '{f['name']}'",
                              {"fence": f["name"]})
            hub.broadcast({"kind": "event", "event": ev})

        if f["kind"] == "safe" and was and not inside:
            ev = db.add_event(device_id, "geofence", "warn",
                              f"Left SAFE zone '{f['name']}'",
                              {"fence": f["name"]})
            hub.broadcast({"kind": "event", "event": ev})


# ----------------------------------------------------------------------------
# device-facing API & remote command channel
# ----------------------------------------------------------------------------
_commands: dict[str, list[dict]] = {}


@app.post("/api/ping")
async def api_ping(request: Request, who: Principal = Depends(require_principal)):
    body = await request.json()
    device_id = who.device_id or str(body.get("device_id") or "unknown")
    name = body.get("name")
    ts = float(body.get("ts") or time.time())
    lat = body.get("lat")
    lon = body.get("lon")
    accuracy = body.get("accuracy")
    extra = body.get("extra")

    # No GPS (laptops) or only a coarse IP guess? Try the personal WiFi map first.
    wifi = body.get("wifi") or []
    bluetooth = body.get("bluetooth") or []
    coarse = lat is None or (isinstance(extra, dict) and extra.get("source") == "ip")
    if coarse and wifi:
        fix = db.locate_from_wifi([w.get("bssid") for w in wifi], device_id)
        if fix:
            lat, lon, accuracy = fix["lat"], fix["lon"], fix["accuracy"]
            extra = dict(extra or {}, source="learned-wifi")

    db.touch_device(device_id, name)
    if body.get("kind") in DEVICE_KINDS:
        db.set_device_kind(device_id, body["kind"])
    db.add_ping(
        device_id, ts, lat, lon,
        accuracy, body.get("speed"), body.get("heading"),
        body.get("battery"), extra, wifi, bluetooth,
    )

    if lat is not None and lon is not None:
        check_geofences(device_id, lat, lon, speed=body.get("speed"), accuracy=accuracy, name=name)
        check_places(device_id, lat, lon)

    # Drain pending commands after geofence evaluation so any emergency helpline commands are returned immediately
    pending = _commands.pop(device_id, [])

    hub.broadcast({"kind": "ping", "device_id": device_id, "ping": {
        "ts": ts, "lat": lat, "lon": lon, "accuracy": accuracy,
        "speed": body.get("speed"), "battery": body.get("battery"),
        "name": name, "wifi": wifi, "bluetooth": bluetooth,
        "extra": extra}})
    return {
        "ok": True,
        "commands": pending,
        "fix": {"lat": lat, "lon": lon, "accuracy": accuracy,
                "source": (extra or {}).get("source") if isinstance(extra, dict) else None}
            if lat is not None else None
    }


@app.post("/api/ping/batch")
async def api_ping_batch(request: Request, who: Principal = Depends(require_principal)):
    body = await request.json()
    device_id = who.device_id or str(body.get("device_id") or "unknown")
    name = body.get("name")
    pings = body.get("pings") or []
    if not pings:
        return {"ok": True, "count": 0, "commands": []}

    last_fix = None

    for p in pings:
        ts = float(p.get("ts") or time.time())
        lat = p.get("lat")
        lon = p.get("lon")
        accuracy = p.get("accuracy")
        speed = p.get("speed")
        heading = p.get("heading")
        battery = p.get("battery")
        extra = p.get("extra")
        wifi = p.get("wifi") or []
        bluetooth = p.get("bluetooth") or []

        db.add_ping(
            device_id, ts, lat, lon,
            accuracy, speed, heading,
            battery, extra, wifi, bluetooth,
        )
        if lat is not None and lon is not None:
            check_geofences(device_id, lat, lon, speed=speed, accuracy=accuracy, name=name)
            check_places(device_id, lat, lon)
            last_fix = {"ts": ts, "lat": lat, "lon": lon, "accuracy": accuracy,
                        "speed": speed, "battery": battery, "name": name, "wifi": wifi, "bluetooth": bluetooth,
                        "extra": extra}

    db.touch_device(device_id, name)
    pending = _commands.pop(device_id, [])
    if last_fix:
        hub.broadcast({"kind": "ping", "device_id": device_id, "ping": last_fix})
    hub.broadcast({"kind": "refresh"})

    return {
        "ok": True,
        "count": len(pings),
        "commands": pending
    }


@app.post("/api/trigger")
async def api_trigger(request: Request, who: Principal = Depends(require_principal)):
    body = await request.json()
    device_id = who.device_id or str(body.get("device_id") or "unknown")
    kind = body.get("kind", "sos")
    msg = body.get("message") or "SOS triggered"
    db.touch_device(device_id, body.get("name"))
    ev = db.add_event(device_id, "sos", "critical", msg,
                      {"lat": body.get("lat"), "lon": body.get("lon"), "kind": kind})
    hub.broadcast({"kind": "event", "event": ev})
    return {"ok": True}


@app.post("/api/frame")
async def api_frame(request: Request, who: Principal = Depends(require_principal)):
    body = await request.json()
    device_id = who.device_id or str(body.get("device_id") or "unknown")
    kind = body.get("kind", "manual")
    image = body.get("image_b64", "")
    if "," in image:  # strip data URL prefix if present
        image = image.split(",", 1)[1]
    try:
        raw = base64.b64decode(image)
    except Exception:
        raise HTTPException(400, "bad image")
    ts = time.time()
    fname = f"{device_id}_{int(ts*1000)}.jpg".replace("/", "_")
    (db.FRAMES_DIR / fname).write_bytes(raw)
    db.add_frame(device_id, ts, fname, kind)
    db.touch_device(device_id)
    ev = db.add_event(device_id, "frame", "info", f"Webcam frame received ({kind})", {"path": fname})
    hub.broadcast({"kind": "frame", "device_id": device_id,
                   "frame": {"ts": ts, "path": fname, "kind": kind}})
    hub.broadcast({"kind": "event", "event": ev})
    return {"ok": True}


@app.post("/api/upload")
async def api_upload(request: Request, who: Principal = Depends(require_principal)):
    form = await request.form()
    device_id = who.device_id or str(form.get("device_id") or "unknown")
    reason = str(form.get("reason") or "manual")
    file = form.get("file")
    if not file:
        raise HTTPException(400, "missing file")
    raw = await file.read() if hasattr(file, "read") else bytes(file)
    ts = time.time()
    fname = f"{device_id}_{int(ts*1000)}.jpg".replace("/", "_")
    (db.FRAMES_DIR / fname).write_bytes(raw)
    db.add_frame(device_id, ts, fname, reason)
    db.touch_device(device_id)
    ev = db.add_event(device_id, "snapshot", "info", f"Snapshot captured ({reason})", {"path": fname})
    hub.broadcast({"kind": "frame", "device_id": device_id,
                   "frame": {"ts": ts, "path": fname, "kind": reason}})
    hub.broadcast({"kind": "event", "event": ev})
    return {"ok": True, "path": fname}


@app.post("/api/sos")
async def api_sos(request: Request, who: Principal = Depends(require_principal)):
    try:
        body = await request.json()
    except Exception:
        body = {}
    device_id = who.device_id or str(body.get("device_id") or "unknown")
    db.touch_device(device_id)
    ev = db.add_event(device_id, "sos", "critical", "🚨 SOS triggered on phone",
                      {"ts": time.time()})
    hub.broadcast({"kind": "event", "event": ev})
    return {"ok": True}


@app.post("/api/event")
async def api_device_event(request: Request, who: Principal = Depends(require_principal)):
    body = await request.json()
    device_id = who.device_id or str(body.get("device_id") or "unknown")
    t = body.get("type", "info")
    sev = "warn" if "error" in t.lower() else "info"
    ev = db.add_event(device_id, t, sev, body.get("message", "Device event"), body)
    hub.broadcast({"kind": "event", "event": ev})
    return {"ok": True}


# ----------------------------------------------------------------------------
# dashboard API (same token)
# ----------------------------------------------------------------------------
@app.get("/api/state")
def api_state(request: Request, _=Depends(require_token)):
    devices = db.list_devices()
    for d in devices:
        d["last_ping"] = db.last_ping(d["id"])
        d["last_fix"] = db.last_fix(d["id"])
        d["wifi"] = db.last_wifi(d["id"])
        d["bluetooth"] = db.last_bluetooth(d["id"])
    return {
        "devices": devices,
        "events": db.recent_events(80),
        "frames": db.recent_frames(limit=60),
        "geofences": db.list_geofences(),
        "places": db.list_places(),
        "offline_timeout": OFFLINE_TIMEOUT,
        "now": time.time(),
    }


@app.get("/api/track/{device_id}")
def api_track(device_id: str, request: Request, _=Depends(require_token)):
    return {"track": db.track(device_id, 400)}


@app.post("/api/track/{device_id}/clear")
def api_clear_track_post(device_id: str, request: Request, _=Depends(require_token)):
    db.clear_track(device_id)
    hub.broadcast({"kind": "track_cleared", "device_id": device_id})
    return {"ok": True, "message": "Path history cleared"}


@app.delete("/api/track/{device_id}")
def api_clear_track_del(device_id: str, request: Request, _=Depends(require_token)):
    db.clear_track(device_id)
    hub.broadcast({"kind": "track_cleared", "device_id": device_id})
    return {"ok": True, "message": "Path history cleared"}


@app.post("/api/geofence")
async def api_add_geofence(request: Request, _=Depends(require_token)):
    b = await request.json()
    gid = db.add_geofence(b["name"], float(b["lat"]), float(b["lon"]),
                          float(b["radius"]), b.get("kind", "danger"))
    hub.broadcast({"kind": "refresh"})
    return {"ok": True, "id": gid}


@app.delete("/api/geofence/{gid}")
def api_del_geofence(gid: int, request: Request, _=Depends(require_token)):
    db.delete_geofence(gid)
    hub.broadcast({"kind": "refresh"})
    return {"ok": True}


@app.post("/api/geofence/bulk")
async def api_bulk_geofence(request: Request, _=Depends(require_token)):
    """Import many danger zones at once (hotspot ingest). Body:
       {items:[{name,lat,lon,radius,kind}], replace_kind:"danger"|null}"""
    b = await request.json()
    items = b.get("items", [])
    if b.get("replace_kind"):
        db.clear_geofences(b["replace_kind"])
    rows = [(it.get("name", "hotspot"), it["lat"], it["lon"],
             it.get("radius", PROXIMITY_WARN_M), it.get("kind", "danger")) for it in items]
    n = db.add_geofences_bulk(rows)
    _zone_state.clear()
    hub.broadcast({"kind": "refresh"})
    return {"ok": True, "added": n}


@app.get("/api/config")
def api_config(request: Request, who: Principal = Depends(require_principal)):
    """Client config: helpline numbers, proximity radius, danger zones and known
       places so phones can warn/log on approach even without the dashboard open."""
    device_id = who.device_id or request.query_params.get("device_id")
    return {
        "helplines": HELPLINES,
        "proximity_warn_m": PROXIMITY_WARN_M,
        "danger_zones": [g for g in db.list_geofences() if g["kind"] == "danger"],
        "places": db.list_places(device_id) if device_id else db.list_places(),
    }


# ---- emergency authority call ----
@app.post("/api/authority/call")
async def api_call_authority(request: Request, _=Depends(require_token)):
    dev_id = request.query_params.get("device_id")
    b = {}
    try:
        b = await request.json()
    except Exception:
        pass
    dev_id = dev_id or b.get("device_id")
    number = b.get("number", "112")
    
    # Get device fix if available
    fix = db.last_fix(dev_id) if dev_id else None
    lat = fix.get("lat") if fix else None
    lon = fix.get("lon") if fix else None
    maps_url = f"https://maps.google.com/?q={lat:.5f},{lon:.5f}" if lat is not None and lon is not None else None
    
    dev_name = "My Phone"
    if dev_id:
        dev_rec = db.get_device(dev_id)
        if dev_rec and dev_rec.get("name"):
            dev_name = dev_rec["name"]
            
    # 1. Enqueue emergency_helpline command for the device
    cmd = {
        "cmd": "emergency_helpline",
        "args": {
            "number": number,
            "zone": "Emergency Guardian Outreach",
            "lat": lat,
            "lon": lon,
            "maps_url": maps_url,
            "message": f"EMERGENCY: Guardian triggered authority dispatch for {dev_name}. Lat: {lat}, Lon: {lon}. Map: {maps_url}"
        }
    }
    if dev_id:
        _commands.setdefault(dev_id, []).append(cmd)
    
    # 2. Add high-priority emergency event
    ev = db.add_event(
        dev_id, "helpline", "critical",
        f"Guardian triggered emergency call to authority ({number}) for {dev_name}",
        {"helpline": number, "lat": lat, "lon": lon, "maps_url": maps_url}
    )
    
    # 3. Broadcast helpline_alert to all open dashboards
    alert_payload = {
        "kind": "helpline_alert",
        "device_id": dev_id,
        "name": dev_name,
        "helpline": number,
        "zone": "Emergency Authority Dispatch",
        "lat": lat,
        "lon": lon,
        "maps_url": maps_url,
        "dwell_s": 0,
        "event": ev
    }
    hub.broadcast(alert_payload)
    
    return {
        "ok": True,
        "dispatched": True,
        "number": number,
        "lat": lat,
        "lon": lon,
        "maps_url": maps_url
    }


# ---- places: home / office / learned frequent spots ----
@app.get("/api/places")
def api_places(request: Request, _=Depends(require_token)):
    return {"places": db.list_places(request.query_params.get("device_id"))}


@app.post("/api/places")
async def api_add_place(request: Request, who: Principal = Depends(require_principal)):
    b = await request.json()
    device_id = who.device_id or b.get("device_id")      # a device can only add its own places
    lat = float(b["lat"])
    lon = float(b["lon"])
    radius = float(b.get("radius", 150))
    kind = b.get("kind", "custom")
    name = b.get("name", "Place")
    pid = db.set_or_update_place(
        device_id,
        name,
        lat,
        lon,
        radius,
        kind
    )
    if kind == "danger":
        fences = db.list_geofences()
        exists = any(f["kind"] == "danger" and _haversine_m(lat, lon, f["lat"], f["lon"]) < 60 for f in fences)
        if not exists:
            db.add_geofence(name, lat, lon, radius if radius > 150 else 250, "danger")
    elif kind in ("home", "office"):
        fences = db.list_geofences()
        for f in fences:
            if f["kind"] == "danger" and _haversine_m(lat, lon, f["lat"], f["lon"]) < 80:
                db.delete_geofence(f["id"])

    _place_state.pop(device_id, None)
    _zone_state.pop(device_id, None)
    hub.broadcast({"kind": "refresh"})
    return {"ok": True, "id": pid}


@app.post("/api/places/{pid}/rename")
async def api_rename_place(pid: int, request: Request, _=Depends(require_token)):
    b = await request.json()
    db.rename_place(pid, b["name"], b.get("kind"))
    _place_state.clear()
    _zone_state.clear()
    hub.broadcast({"kind": "refresh"})
    return {"ok": True}


@app.post("/api/places/clear")
def api_clear_places(request: Request, _=Depends(require_token)):
    dev_id = request.query_params.get("device_id")
    db.clear_places(dev_id)
    if dev_id:
        _place_state.pop(dev_id, None)
    else:
        _place_state.clear()
    _zone_state.clear()
    hub.broadcast({"kind": "places_cleared", "device_id": dev_id})
    return {"ok": True, "message": "Places cleared"}


@app.delete("/api/places/clear")
def api_clear_places_delete(request: Request, _=Depends(require_token)):
    return api_clear_places(request)


@app.delete("/api/places/{pid}")
def api_del_place(pid: int, request: Request, _=Depends(require_token)):
    places = db.list_places()
    target = next((p for p in places if p["id"] == pid), None)
    if target and target.get("kind") == "danger":
        fences = db.list_geofences()
        for f in fences:
            if f["kind"] == "danger" and _haversine_m(target["lat"], target["lon"], f["lat"], f["lon"]) < 80:
                db.delete_geofence(f["id"])
    db.delete_place(pid)
    _place_state.clear()
    _zone_state.clear()
    hub.broadcast({"kind": "refresh"})
    return {"ok": True}


@app.get("/api/places/suggestions/{device_id}")
def api_place_suggestions(device_id: str, request: Request, _=Depends(require_token)):
    return {"suggestions": db.frequent_clusters(device_id)}


# ----------------------------------------------------------------------------
# remote command channel: the dashboard tells a silent phone what to do
# (snapshot now / start-stop live frames).
# ----------------------------------------------------------------------------


@app.post("/api/command")
async def api_command(request: Request, _=Depends(require_token)):
    b = await request.json()
    dev = str(b["device_id"])
    cmd = {"cmd": b["cmd"], "args": b.get("args", {})}
    _commands.setdefault(dev, []).append(cmd)
    ev = db.add_event(dev, "command", "info", f"Guardian Angel sent: {b['cmd']}", cmd)
    hub.broadcast({"kind": "event", "event": ev})
    return {"ok": True}


@app.post("/api/device/{device_id}/interval")
async def api_device_interval(device_id: str, request: Request, _=Depends(require_token)):
    b = await request.json()
    sec = max(2, int(b.get("sec", 10)))
    cmd = {"cmd": "set_interval", "args": {"sec": sec}}
    _commands.setdefault(device_id, []).append(cmd)
    ev = db.add_event(device_id, "command", "info", f"Set location update interval to {sec}s", cmd)
    hub.broadcast({"kind": "event", "event": ev})
    return {"ok": True, "interval": sec}


@app.get("/api/commands")
def api_commands(request: Request, who: Principal = Depends(require_principal)):
    """Phone drains its pending commands (and clears them). A device can only drain its own."""
    dev = who.device_id or request.query_params.get("device_id", "")
    pending = _commands.pop(dev, [])
    return {"commands": pending}


# ----------------------------------------------------------------------------
# find my devices: every paired device (phone, laptop) can see where the others
# are and make them ring. Device tokens get locations + a small set of harmless
# commands only — never camera, SOS, events or frames (those stay admin-only).
# ----------------------------------------------------------------------------
PEER_COMMANDS = {"ring", "ring_stop", "ping_now"}


@app.get("/api/peers")
def api_peers(request: Request, who: Principal = Depends(require_principal)):
    try:
        trail = min(max(int(request.query_params.get("trail", "0")), 0), 200)
    except ValueError:
        trail = 0
    now = time.time()
    peers = []
    for d in db.list_devices():
        if d.get("revoked"):
            continue
        lp = db.last_ping(d["id"]) or {}
        peer = {
            "id": d["id"],
            "name": d["name"],
            "kind": d.get("kind") or "phone",
            "self": d["id"] == who.device_id,
            "last_seen": d["last_seen"],
            "online": (now - (d["last_seen"] or 0)) < OFFLINE_TIMEOUT,
            "battery": lp.get("battery"),
            "fix": db.last_fix(d["id"]),
        }
        if trail:
            peer["trail"] = [[p["lat"], p["lon"]] for p in db.track(d["id"], trail)
                             if p["lat"] is not None]
        peers.append(peer)
    return {"me": who.device_id, "now": now, "offline_timeout": OFFLINE_TIMEOUT, "peers": peers}


@app.post("/api/peers/{device_id}/command")
async def api_peer_command(device_id: str, request: Request,
                           who: Principal = Depends(require_principal)):
    b = await request.json()
    cmd = b.get("cmd")
    if cmd not in PEER_COMMANDS:
        raise HTTPException(400, f"cmd must be one of {sorted(PEER_COMMANDS)}")
    target = next((d for d in db.list_devices() if d["id"] == device_id), None)
    if not target or target.get("revoked"):
        raise HTTPException(404, "no such device")
    sender = "dashboard"
    if who.device_id:
        me = next((d for d in db.list_devices() if d["id"] == who.device_id), None)
        sender = (me or {}).get("name") or who.device_id
    _commands.setdefault(device_id, []).append({"cmd": cmd, "args": {"from": sender}})
    ev = db.add_event(device_id, "command", "info",
                      f"{sender} sent {cmd} to {target['name']}", {"cmd": cmd, "from": sender})
    hub.broadcast({"kind": "event", "event": ev})
    return {"ok": True}


# ----------------------------------------------------------------------------
# pairing: the dashboard issues a short-lived code; the phone claims it to get
# the token. A phone can't join by guessing the server URL alone.
# ----------------------------------------------------------------------------
PAIR_TTL = 600          # seconds a code stays valid
_PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # no ambiguous chars
_pairings: dict[str, dict] = {}   # code -> {created, used}


def _purge_pairings():
    now = time.time()
    for code in [c for c, v in _pairings.items() if now - v["created"] > PAIR_TTL or v["used"]]:
        _pairings.pop(code, None)


@app.post("/api/pair/new")
def api_pair_new(request: Request, _=Depends(require_token)):
    """Dashboard (already authed) mints a one-time pairing code."""
    _purge_pairings()
    code = "".join(secrets.choice(_PAIR_ALPHABET) for _ in range(6))
    _pairings[code] = {"created": time.time(), "used": False}
    base = f"http://{lan_ip()}:{PORT}"
    # `url` is what the QR encodes: scanning it on the same WiFi gives the phone
    # both the server address and the code, so pairing is one tap.
    return {"code": code, "ttl": PAIR_TTL, "server": base, "url": f"{base}/pwa/?code={code}"}


@app.post("/api/pair/claim")
async def api_pair_claim(request: Request):
    """Phone exchanges a valid code for the token. No token required here."""
    _purge_pairings()
    b = await request.json()
    code = str(b.get("code", "")).strip().upper()
    entry = _pairings.get(code)
    if not entry or entry["used"] or (time.time() - entry["created"] > PAIR_TTL):
        raise HTTPException(status_code=400, detail="invalid or expired code")
    entry["used"] = True
    device_id = "dev-" + secrets.token_hex(4)
    name = (b.get("name") or "paired phone").strip()
    kind = b.get("kind") if b.get("kind") in DEVICE_KINDS else None
    dev_token = secrets.token_urlsafe(24)            # unique per-device token
    db.create_paired_device(device_id, name, dev_token, kind)
    ev = db.add_event(device_id, "pair", "info", f"Paired new device: {name}", None)
    hub.broadcast({"kind": "event", "event": ev})
    return {"ok": True, "token": dev_token, "device_id": device_id, "name": name}


@app.post("/api/device/{device_id}/revoke")
def api_revoke(device_id: str, request: Request, _=Depends(require_admin)):
    """Disable one phone's token immediately. Other devices are unaffected."""
    db.set_device_revoked(device_id, True)
    ev = db.add_event(device_id, "revoke", "warn", "Device access revoked", None)
    hub.broadcast({"kind": "event", "event": ev})
    return {"ok": True}


@app.post("/api/device/{device_id}/restore")
def api_restore(device_id: str, request: Request, _=Depends(require_admin)):
    db.set_device_revoked(device_id, False)
    hub.broadcast({"kind": "refresh"})
    return {"ok": True}


@app.post("/api/ack/{event_id}")
def api_ack(event_id: int, request: Request, _=Depends(require_token)):
    db.ack_event(event_id)
    return {"ok": True}


@app.get("/frames/{name}")
def get_frame(name: str, request: Request, _=Depends(require_token)):
    p = db.FRAMES_DIR / name
    if not p.exists() or "/" in name or ".." in name:
        raise HTTPException(404)
    return FileResponse(p, media_type="image/jpeg")


# ----------------------------------------------------------------------------
# websocket
# ----------------------------------------------------------------------------
@app.websocket("/ws")
async def ws(ws: WebSocket):
    tok = ws.query_params.get("token", "")
    if not secrets.compare_digest(tok, TOKEN):
        await ws.close(code=4404)
        return
    await hub.join(ws)
    try:
        while True:
            await ws.receive_text()  # keepalive / ignore
    except WebSocketDisconnect:
        hub.leave(ws)
    except Exception:
        hub.leave(ws)


# ----------------------------------------------------------------------------
# watchdog: alert when an armed device goes silent
# ----------------------------------------------------------------------------
async def watchdog():
    cycles = 0
    while True:
        await asyncio.sleep(15)
        cycles += 1
        try:
            for d in db.devices_to_mark_offline(OFFLINE_TIMEOUT):
                db.set_offline(d["id"])
                ev = db.add_event(d["id"], "offline", "warn",
                                  f"{d['name']} went silent "
                                  f"({int(OFFLINE_TIMEOUT)}s no signal)", None)
                hub.broadcast({"kind": "event", "event": ev})
            # every ~5 min, learn frequently-visited spots and enforce 3-day retention
            if cycles % 20 == 0:
                for d in db.list_devices():
                    auto_learn_places(d["id"])
                db.prune_pings()
                db.prune_events()
        except Exception as e:  # never let the loop die
            print("watchdog error:", e)


@app.on_event("startup")
async def _startup():
    db.init()
    if not db.get_session(TOKEN):
        db.init_session(TOKEN, 86400)
    hub.loop = asyncio.get_running_loop()
    asyncio.create_task(watchdog())


# ----------------------------------------------------------------------------
# session control: check status, renew, or immediately end hosting
# ----------------------------------------------------------------------------
@app.get("/api/session")
def api_session_status(request: Request):
    s = db.get_session(TOKEN)
    if not s or not s.get("active"):
        return {"active": False, "expired": True, "remaining_seconds": 0}
    now = time.time()
    exp = float(s.get("expires_at", 0))
    rem = max(0, exp - now)
    return {
        "active": rem > 0 and bool(s.get("active")),
        "expired": rem <= 0 or not bool(s.get("active")),
        "created_at": s.get("created_at"),
        "expires_at": exp,
        "remaining_seconds": rem,
    }


@app.post("/api/session/renew")
async def api_session_renew(request: Request, _=Depends(require_admin_renew)):
    try:
        b = await request.json()
        hours = float(b.get("hours", 24))
    except Exception:
        hours = 24.0
    res = db.renew_session(TOKEN, hours * 3600)
    return {"ok": True, **res}


@app.post("/api/session/end")
def api_session_end(request: Request, _=Depends(require_admin_renew)):
    db.end_session(TOKEN)
    hub.broadcast({"kind": "event", "event": {"message": "Hosting session ended"}})
    return {"ok": True, "message": "Session ended. Web links will now return 404."}


# ----------------------------------------------------------------------------
# pages: dashboard (/) and phone app (/app). Token gate is client-side.
# ----------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request):
    tok = request.query_params.get("token", "")
    cookie_tok = request.cookies.get("guardian_token", "")
    html = (HERE / "static" / "dashboard.html").read_text()
    host = request.url.hostname or ""
    client_host = request.client.host if request.client else ""
    is_local = host in ("localhost", "127.0.0.1", "::1") or client_host in ("127.0.0.1", "::1") or (lan_ip() in str(request.base_url))
    has_valid_tok = bool(tok and secrets.compare_digest(tok, TOKEN)) or bool(cookie_tok and secrets.compare_digest(cookie_tok, TOKEN))
    effective_token = TOKEN if (has_valid_tok or is_local) else ""
    resp = HTMLResponse(content=html.replace("__DEFAULT_TOKEN__", effective_token))
    if tok and secrets.compare_digest(tok, TOKEN):
        resp.set_cookie("guardian_token", TOKEN, max_age=31536000, path="/", samesite="lax")
    return resp


@app.get("/app")
def phone_app():
    # phone app lives at /pwa/ so its service worker scope matches the page
    from fastapi.responses import RedirectResponse
    return RedirectResponse("/pwa/")


@app.get("/download/Stratus.apk")
@app.get("/download/stratus.apk")
@app.get("/Stratus.apk")
@app.get("/stratus.apk")
def download_stratus_apk():
    repo_root = HERE.parent
    candidates = [
        HERE / "data" / "Stratus.apk",
        HERE / "data" / "stratus.apk",
        repo_root / "weather" / "Stratus.apk",
        Path.home() / "Downloads" / "Stratus.apk",
        Path.home() / "Downloads" / "stratus.apk",
    ]
    for p in candidates:
        if p.exists() and p.is_file() and p.stat().st_size > 1000:
            return FileResponse(
                path=str(p),
                filename="Stratus.apk",
                media_type="application/vnd.android.package-archive"
            )
    raise HTTPException(status_code=404, detail="Stratus.apk not found. Please compile the APK using ./build.sh or sshlocation rebuild.")


# serve the phone app + its assets. html=True -> /pwa/ returns index.html,
# and /pwa/sw.js is at the app's scope root so it can control the page.
app.mount("/pwa", StaticFiles(directory=HERE / "pwa", html=True), name="pwa")
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


if __name__ == "__main__":
    import uvicorn
    print(f"  Guardian on http://{lan_ip()}:{PORT}  (dashboard + /pwa/)")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
