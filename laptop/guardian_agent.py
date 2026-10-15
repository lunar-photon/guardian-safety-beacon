#!/usr/bin/env python3
"""
Guardian laptop beacon — makes your laptop findable from your phone.

Laptops have no GPS, so position comes from nearby WiFi networks looked up in
beaconDB (the free, keyless successor to Mozilla Location Service), falling back
to IP geolocation (city-level). Battery level is read from /sys. The agent also
obeys "ring" / "locate now" sent from the phone's Find screen.

Pure standard library — no pip install. Linux with NetworkManager (nmcli) for WiFi.

    python3 guardian_agent.py pair --server http://192.168.1.5:8000 --code ABC123
    python3 guardian_agent.py locate          # test: print where we think we are
    python3 guardian_agent.py run             # foreground loop
    python3 guardian_agent.py install         # run at login as a systemd user service

Privacy: a WiFi lookup sends nearby access-point MACs to api.beacondb.net and the
IP fallback asks ipinfo.io — the same kind of lookup your browser makes for
location. Use --source ip or --source none to limit that.
"""
import argparse
import json
import math
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

CONFIG_PATH = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "guardian-agent" / "config.json"
USER_AGENT = "guardian-agent/1.0 (self-hosted find-my-device)"
BEACONDB_URL = "https://api.beacondb.net/v1/geolocate"
IPINFO_URL = "https://ipinfo.io/json"
CMD_POLL_S = 5
RING_MAX_S = 60


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# config + http
# ---------------------------------------------------------------------------
def load_config():
    try:
        return json.loads(CONFIG_PATH.read_text())
    except FileNotFoundError:
        sys.exit(f"Not paired yet. Run:  {sys.argv[0]} pair --server URL --code CODE")


def save_config(cfg):
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
    CONFIG_PATH.chmod(0o600)          # holds the device token


def http_json(url, body=None, token=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("User-Agent", USER_AGENT)
    if data:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


# ---------------------------------------------------------------------------
# location: WiFi (beaconDB) -> IP fallback
# ---------------------------------------------------------------------------
def wifi_scan():
    """Nearby access points via NetworkManager. [] if nmcli/WiFi is unavailable."""
    if not shutil.which("nmcli"):
        return []
    try:
        out = subprocess.run(
            ["nmcli", "-t", "-e", "yes", "-f", "BSSID,SIGNAL,SSID",
             "device", "wifi", "list", "--rescan", "auto"],
            capture_output=True, text=True, timeout=25).stdout
    except Exception:
        return []
    aps = []
    for line in out.splitlines():
        parts = re.split(r"(?<!\\):", line, maxsplit=2)   # ':' inside fields is escaped as '\:'
        if len(parts) < 3:
            continue
        bssid = parts[0].replace("\\:", ":").lower()
        ssid = parts[2].replace("\\:", ":").replace("\\\\", "\\")
        if not re.fullmatch(r"([0-9a-f]{2}:){5}[0-9a-f]{2}", bssid):
            continue
        if ssid.endswith("_nomap"):        # owner opted this AP out of location services
            continue
        try:
            pct = int(parts[1])
        except ValueError:
            continue
        aps.append({"ssid": ssid, "bssid": bssid, "rssi": round(pct / 2 - 100)})  # % -> ~dBm
    aps.sort(key=lambda a: -a["rssi"])
    return aps[:15]


class Locator:
    """Caches lookups so we only ask the web services when something changed."""

    def __init__(self, source="auto"):
        self.source = source
        self._wifi_key = None
        self._wifi_fix = None
        self._ip_fix = None
        self._ip_at = 0.0

    def locate(self, aps):
        if self.source in ("auto", "wifi") and len(aps) >= 2:   # beaconDB needs 2+ APs
            fix = self._from_wifi(aps)
            if fix:
                return fix
        if self.source in ("auto", "ip"):
            return self._from_ip()
        return None

    def _from_wifi(self, aps):
        key = frozenset(a["bssid"] for a in aps[:6])
        if key == self._wifi_key and self._wifi_fix:
            return self._wifi_fix              # same surroundings -> same place, skip the API
        body = {"considerIp": False, "wifiAccessPoints": [
            {"macAddress": a["bssid"], "signalStrength": a["rssi"]} for a in aps]}
        try:
            r = http_json(BEACONDB_URL, body)
            loc = r["location"]
            self._wifi_key = key
            self._wifi_fix = {"lat": loc["lat"], "lon": loc["lng"],
                              "accuracy": r.get("accuracy"), "source": "wifi"}
            return self._wifi_fix
        except urllib.error.HTTPError as e:
            if e.code != 404:                  # 404 = these networks aren't in the database yet
                log("beaconDB error:", e.code)
        except Exception as e:
            log("beaconDB unreachable:", e)
        return None

    def _from_ip(self):
        if self._ip_fix and time.time() - self._ip_at < 900:
            return self._ip_fix
        try:
            r = http_json(IPINFO_URL)
            lat, lon = (float(x) for x in r["loc"].split(","))
            self._ip_fix = {"lat": lat, "lon": lon, "accuracy": 10000, "source": "ip",
                            "city": r.get("city")}
            self._ip_at = time.time()
            return self._ip_fix
        except Exception as e:
            log("IP geolocation failed:", e)
            return self._ip_fix


def battery():
    """(percent, charging) from the first battery in /sys, or (None, None)."""
    for bat in sorted(Path("/sys/class/power_supply").glob("BAT*")):
        try:
            pct = int((bat / "capacity").read_text().strip())
            status = (bat / "status").read_text().strip().lower()
            return pct, status in ("charging", "full")
        except Exception:
            continue
    return None, None


# ---------------------------------------------------------------------------
# ring: loud beeps at full volume until stopped (or RING_MAX_S)
# ---------------------------------------------------------------------------
class Ringer:
    PLAYERS = (["pw-play"], ["paplay"], ["aplay", "-q"], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"])

    def __init__(self):
        self._stop = threading.Event()
        self._thread = None
        self._wav = None

    def _beep_file(self):
        if self._wav:
            return self._wav
        rate = 22050
        frames = bytearray()
        for i, freq in enumerate((1760, 1320, 1760)):          # three short chirps
            for n in range(int(rate * 0.18)):
                v = 0.8 if math.sin(2 * math.pi * freq * n / rate) > 0 else -0.8
                frames += struct.pack("<h", int(v * 32767 * (1 - n / (rate * 0.18))))
            frames += b"\0\0" * int(rate * 0.07)
        fd, path = tempfile.mkstemp(prefix="guardian-ring-", suffix=".wav")
        with os.fdopen(fd, "wb") as f, wave.open(f, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(bytes(frames))
        self._wav = path
        return path

    def start(self, who="your phone"):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, args=(who,), daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self, who):
        if shutil.which("notify-send"):
            subprocess.run(["notify-send", "-u", "critical", "-a", "Guardian",
                            "🔔 Found it!", f"{who} is ringing this laptop."], check=False)
        restore = self._max_volume()
        player = next((p for p in self.PLAYERS if shutil.which(p[0])), None)
        if not player:
            log("ring: no audio player found (pw-play/paplay/aplay/ffplay)")
        wav = self._beep_file()
        end = time.time() + RING_MAX_S
        while not self._stop.is_set() and time.time() < end:
            if player:
                subprocess.run(player + [wav], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self._stop.wait(0.4)
        if restore:
            restore()

    @staticmethod
    def _max_volume():
        """Unmute + full volume (PipeWire's wpctl). Returns a function that undoes it."""
        if not shutil.which("wpctl"):
            return None
        sink = "@DEFAULT_AUDIO_SINK@"
        try:
            cur = subprocess.run(["wpctl", "get-volume", sink], capture_output=True, text=True, timeout=5).stdout
            m = re.search(r"Volume:\s*([\d.]+)", cur)
            muted = "MUTED" in cur
            subprocess.run(["wpctl", "set-mute", sink, "0"], check=False)
            subprocess.run(["wpctl", "set-volume", sink, "1.0"], check=False)
        except Exception:
            return None

        def restore():
            if m:
                subprocess.run(["wpctl", "set-volume", sink, m.group(1)], check=False)
            if muted:
                subprocess.run(["wpctl", "set-mute", sink, "1"], check=False)
        return restore


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------
def cmd_pair(a):
    server = a.server.rstrip("/")
    name = a.name or f"{socket.gethostname()} (laptop)"
    try:
        d = http_json(server + "/api/pair/claim",
                      {"code": a.code.strip().upper(), "name": name, "kind": "laptop"})
    except urllib.error.HTTPError as e:
        sys.exit(f"Pairing failed ({e.code}) — code wrong or expired. Make a new one on the dashboard.")
    except Exception as e:
        sys.exit(f"Can't reach {server}: {e}")
    save_config({"server": server, "token": d["token"], "device_id": d["device_id"], "name": d["name"]})
    print(f"Paired as '{d['name']}' ({d['device_id']}). Config: {CONFIG_PATH}")
    print(f"Next:  {sys.argv[0]} run      (or 'install' to start at every login)")


def cmd_locate(a):
    aps = wifi_scan()
    print(f"{len(aps)} WiFi networks visible")
    fix = Locator(a.source).locate(aps)
    print(json.dumps(fix, indent=2) if fix else "No position (no usable WiFi data and IP lookup off/failed).")
    pct, charging = battery()
    print(f"Battery: {pct}%{' (charging)' if charging else ''}" if pct is not None else "Battery: n/a")


def cmd_run(a):
    cfg = load_config()
    server, token = cfg["server"], cfg["token"]
    locator, ringer = Locator(a.source), Ringer()
    log(f"Guardian laptop beacon '{cfg['name']}' -> {server} (every {a.interval}s, source={a.source})")
    next_ping = 0.0
    while True:
        now = time.time()
        if now >= next_ping:
            next_ping = now + a.interval
            aps = wifi_scan()
            fix = locator.locate(aps)
            pct, charging = battery()
            body = {"device_id": cfg["device_id"], "name": cfg["name"], "kind": "laptop",
                    "ts": now, "battery": pct, "wifi": aps,
                    "extra": {"charging": charging, "source": fix["source"] if fix else None}}
            if fix:
                body.update(lat=fix["lat"], lon=fix["lon"], accuracy=fix["accuracy"])
            try:
                # the server may improve the fix from your phone's WiFi history
                fix = http_json(server + "/api/ping", body, token).get("fix") or fix
                log("ping", f"{fix['lat']:.5f},{fix['lon']:.5f} ±{fix['accuracy']}m via {fix['source']}"
                    if fix else "(no position)", f"battery={pct}")
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    sys.exit("Server rejected this laptop's token (revoked?). Pair again.")
                log("ping failed:", e.code)
            except Exception as e:
                log("server unreachable:", e)
        try:
            for c in http_json(server + "/api/commands", token=token).get("commands", []):
                log("command:", c.get("cmd"))
                if c.get("cmd") == "ring":
                    ringer.start((c.get("args") or {}).get("from") or "your phone")
                elif c.get("cmd") == "ring_stop":
                    ringer.stop()
                elif c.get("cmd") == "ping_now":
                    next_ping = 0.0
        except Exception:
            pass
        time.sleep(CMD_POLL_S if next_ping else 0)


def cmd_install(a):
    load_config()   # refuse before pairing
    unit_dir = Path.home() / ".config" / "systemd" / "user"
    unit_dir.mkdir(parents=True, exist_ok=True)
    unit = unit_dir / "guardian-agent.service"
    unit.write_text(f"""[Unit]
Description=Guardian laptop beacon (find my laptop)
After=network-online.target

[Service]
ExecStart={sys.executable} {Path(__file__).resolve()} run --interval {a.interval} --source {a.source}
Restart=always
RestartSec=20

[Install]
WantedBy=default.target
""")
    print(f"Wrote {unit}")
    if not shutil.which("systemctl"):
        sys.exit("systemctl not found — start '... run' some other way at login.")
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", "guardian-agent.service"], check=True)
    print("Running. Logs:  journalctl --user -u guardian-agent -f")
    print("Tip: 'loginctl enable-linger' keeps it running even before you log in.")


def main():
    p = argparse.ArgumentParser(description="Guardian laptop beacon")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("pair", help="pair with a code from the dashboard")
    s.add_argument("--server", required=True, help="e.g. http://192.168.1.5:8000 or your ngrok URL")
    s.add_argument("--code", required=True)
    s.add_argument("--name", help="how this laptop shows on the map (default: hostname)")
    for name, help_ in (("locate", "print the current position (sends nothing to your server)"),
                        ("run", "report location + obey ring/locate commands"),
                        ("install", "install + start as a systemd user service")):
        s = sub.add_parser(name, help=help_)
        s.add_argument("--source", choices=("auto", "wifi", "ip", "none"), default="auto",
                       help="auto = WiFi, then IP fallback")
        if name != "locate":
            s.add_argument("--interval", type=int, default=60, help="seconds between location reports")
    a = p.parse_args()
    if getattr(a, "interval", 60) < 10:
        p.error("--interval must be at least 10 seconds")
    {"pair": cmd_pair, "locate": cmd_locate, "run": cmd_run, "install": cmd_install}[a.cmd](a)


if __name__ == "__main__":
    main()
