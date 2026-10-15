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
This is a single-operator tool for watching your OWN devices.
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

OFFLINE_TIMEOUT = float(os.environ.get("OFFLINE_TIMEOUT", "90"))   # seconds of silence -> alert
PROXIMITY_WARN_M = float(os.environ.get("PROXIMITY_WARN_M", "300"))  # warn when this close to a danger zone
PORT = int(os.environ.get("PORT", "8000"))
HERE = Path(__file__).resolve().parent


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
    return request.query_params.get("token", "")


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


def check_geofences(device_id, lat, lon):
    fences = db.list_geofences()
    state = _zone_state.setdefault(device_id, {})
    for f in fences:
        inside = _haversine_m(lat, lon, f["lat"], f["lon"]) <= f["radius"]
        was = state.get(f["id"])
        state[f["id"]] = inside
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
# device-facing API
# ----------------------------------------------------------------------------
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
        body.get("battery"), extra, wifi,
    )

    if lat is not None and lon is not None:
        check_geofences(device_id, lat, lon)
        check_places(device_id, lat, lon)

    hub.broadcast({"kind": "ping", "device_id": device_id, "ping": {
        "ts": ts, "lat": lat, "lon": lon, "accuracy": accuracy,
        "speed": body.get("speed"), "battery": body.get("battery"),
        "name": name, "wifi": wifi}})
    return {"ok": True, "fix": {"lat": lat, "lon": lon, "accuracy": accuracy,
                                "source": (extra or {}).get("source") if isinstance(extra, dict) else None}
            if lat is not None else None}


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
    hub.broadcast({"kind": "frame", "device_id": device_id,
                   "frame": {"ts": ts, "path": fname, "kind": kind}})
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
    return {
        "devices": devices,
        "events": db.recent_events(80),
        "frames": db.recent_frames(limit=12),
        "geofences": db.list_geofences(),
        "places": db.list_places(),
        "offline_timeout": OFFLINE_TIMEOUT,
        "now": time.time(),
    }


@app.get("/api/track/{device_id}")
def api_track(device_id: str, request: Request, _=Depends(require_token)):
    return {"track": db.track(device_id, 400)}


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


# ---- places: home / office / learned frequent spots ----
@app.get("/api/places")
def api_places(request: Request, _=Depends(require_token)):
    return {"places": db.list_places(request.query_params.get("device_id"))}


@app.post("/api/places")
async def api_add_place(request: Request, who: Principal = Depends(require_principal)):
    b = await request.json()
    device_id = who.device_id or b["device_id"]      # a device can only add its own places
    pid = db.add_place(device_id, b.get("name", "Place"), float(b["lat"]),
                       float(b["lon"]), float(b.get("radius", 120)), b.get("kind", "custom"))
    _place_state.pop(device_id, None)
    hub.broadcast({"kind": "refresh"})
    return {"ok": True, "id": pid}


@app.post("/api/places/{pid}/rename")
async def api_rename_place(pid: int, request: Request, _=Depends(require_token)):
    b = await request.json()
    db.rename_place(pid, b["name"], b.get("kind"))
    hub.broadcast({"kind": "refresh"})
    return {"ok": True}


@app.delete("/api/places/{pid}")
def api_del_place(pid: int, request: Request, _=Depends(require_token)):
    db.delete_place(pid)
    hub.broadcast({"kind": "refresh"})
    return {"ok": True}


@app.get("/api/places/suggestions/{device_id}")
def api_place_suggestions(device_id: str, request: Request, _=Depends(require_token)):
    return {"suggestions": db.frequent_clusters(device_id)}


# ----------------------------------------------------------------------------
# remote command channel: the dashboard tells a silent phone what to do
# (snapshot now / start-stop live frames). Phones poll /api/commands.
# ----------------------------------------------------------------------------
_commands: dict[str, list[dict]] = {}


@app.post("/api/command")
async def api_command(request: Request, _=Depends(require_token)):
    b = await request.json()
    dev = str(b["device_id"])
    cmd = {"cmd": b["cmd"], "args": b.get("args", {})}
    _commands.setdefault(dev, []).append(cmd)
    ev = db.add_event(dev, "command", "info", f"Operator sent: {b['cmd']}", cmd)
    hub.broadcast({"kind": "event", "event": ev})
    return {"ok": True}


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
    if not secrets.compare_digest(ws.query_params.get("token", ""), TOKEN):
        await ws.close(code=4401)
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
            # every ~5 min, learn frequently-visited spots for each known device
            if cycles % 20 == 0:
                for d in db.list_devices():
                    auto_learn_places(d["id"])
        except Exception as e:  # never let the loop die
            print("watchdog error:", e)


@app.on_event("startup")
async def _startup():
    db.init()
    hub.loop = asyncio.get_running_loop()
    asyncio.create_task(watchdog())


# ----------------------------------------------------------------------------
# pages: dashboard (/) and phone app (/app). Token gate is client-side.
# ----------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
def dashboard():
    return (HERE / "static" / "dashboard.html").read_text()


@app.get("/app")
def phone_app():
    # phone app lives at /pwa/ so its service worker scope matches the page
    from fastapi.responses import RedirectResponse
    return RedirectResponse("/pwa/")


# serve the phone app + its assets. html=True -> /pwa/ returns index.html,
# and /pwa/sw.js is at the app's scope root so it can control the page.
app.mount("/pwa", StaticFiles(directory=HERE / "pwa", html=True), name="pwa")
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


if __name__ == "__main__":
    import uvicorn
    print(f"  Guardian on http://{lan_ip()}:{PORT}  (dashboard + /pwa/)")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
