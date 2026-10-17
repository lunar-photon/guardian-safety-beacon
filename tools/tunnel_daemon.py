#!/usr/bin/env python3
"""
tunnel_daemon.py: Persistent supervisor for reverse tunnels (Serveo, Ngrok, localhost.run).
Automatically starts, monitors, and auto-reconnects the tunnel,
extracting the live public HTTPS endpoint and keeping server/data/tunnel.url updated.
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "server" / "data"
CONFIG_FILE = DATA_DIR / "tunnel.config"
URL_FILE = DATA_DIR / "tunnel.url"
LOG_FILE = DATA_DIR / "ssh_tunnel.log"
PID_FILE = DATA_DIR / "ssh_tunnel.pid"

DATA_DIR.mkdir(parents=True, exist_ok=True)
PID_FILE.write_text(str(os.getpid()))

running = True

def handle_sig(sig, frame):
    global running
    running = False

signal.signal(signal.SIGTERM, handle_sig)
signal.signal(signal.SIGINT, handle_sig)

def get_config():
    cfg = {"METHOD": "localhost.run"}
    if CONFIG_FILE.exists():
        for line in CONFIG_FILE.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip()
    return cfg

def run_tunnel():
    global running
    cfg = get_config()
    port_val = os.environ.get("PORT")
    if not port_val and (DATA_DIR / "server.port").exists():
        try:
            port_val = (DATA_DIR / "server.port").read_text().strip()
        except Exception:
            pass
    if not port_val:
        port_val = cfg.get("PORT")
    port = int(port_val) if port_val and port_val.isdigit() else 8000

    if method == "serveo":
        sub = cfg.get("SERVEO_SUBDOMAIN", "stratus-guardian").strip()
        pub_url = f"https://{sub}.serveo.net"
        URL_FILE.write_text(pub_url)
        print(f"[Tunnel:Serveo] Serving on {pub_url}", flush=True)
        cmd = [
            "ssh",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "ExitOnForwardFailure=yes",
            "-R", f"{sub}:80:127.0.0.1:{port}",
            "serveo.net"
        ]
    elif method == "ngrok":
        token = cfg.get("NGROK_TOKEN", "").strip()
        domain = cfg.get("NGROK_DOMAIN", "").strip()
        if domain.startswith("http"):
            domain = domain.split("://", 1)[1]
        domain = domain.rstrip("/")
        pub_url = f"https://{domain}"
        URL_FILE.write_text(pub_url)
        print(f"[Tunnel:Ngrok] Serving on {pub_url}", flush=True)
        ngrok_bin = Path(os.environ.get("HOME", "")) / ".local" / "bin" / "ngrok"
        bin_path = str(ngrok_bin) if ngrok_bin.exists() else "ngrok"
        cmd = [
            bin_path,
            "http",
            str(port),
            "--url", pub_url,
            "--log=stdout"
        ]
        if token:
            cmd.extend(["--authtoken", token])
    else:
        # Default: localhost.run
        cmd = [
            "ssh",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "ExitOnForwardFailure=yes",
            "-R", f"80:127.0.0.1:{port}",
            "nokey@localhost.run",
            "--", "--output", "json"
        ]

    with open(LOG_FILE, "a") as log_fp:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )

        while running and proc.poll() is None:
            line = proc.stdout.readline()
            if not line:
                break
            log_fp.write(line)
            log_fp.flush()

            if method == "localhost.run":
                m = re.search(r'https://[a-zA-Z0-9.-]*\.lhr\.life', line)
                if m:
                    url = m.group(0).strip()
                    URL_FILE.write_text(url)
                    print(f"[Tunnel:localhost.run] Active endpoint: {url}", flush=True)

        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try: proc.kill()
            except Exception: pass

print("[Tunnel] Starting persistent supervisor daemon...", flush=True)
while running:
    try:
        run_tunnel()
    except Exception as e:
        print(f"[Tunnel] Error: {e}", flush=True)
    if running:
        print("[Tunnel] Connection dropped or exited, reconnecting in 3 seconds...", flush=True)
        time.sleep(3)

PID_FILE.unlink(missing_ok=True)
print("[Tunnel] Supervisor stopped.", flush=True)
