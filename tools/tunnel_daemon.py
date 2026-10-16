#!/usr/bin/env python3
"""
tunnel_daemon.py: Persistent supervisor for SSH reverse tunnels (localhost.run).
Automatically starts, monitors, and auto-reconnects the SSH tunnel,
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
URL_FILE = DATA_DIR / "tunnel.url"
LOG_FILE = DATA_DIR / "ssh_tunnel.log"
PID_FILE = DATA_DIR / "ssh_tunnel.pid"

DATA_DIR.mkdir(parents=True, exist_ok=True)

# Write supervisor PID
PID_FILE.write_text(str(os.getpid()))

running = True

def handle_sig(sig, frame):
    global running
    running = False

signal.signal(signal.SIGTERM, handle_sig)
signal.signal(signal.SIGINT, handle_sig)

def run_tunnel():
    global running
    port = int(os.environ.get("PORT", "8000"))
    ssh_cmd = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "-o", "ExitOnForwardFailure=yes",
        "-R", f"80:127.0.0.1:{port}",
        "nokey@localhost.run",
        "--", "--output", "json"
    ]
    
    with open(LOG_FILE, "w") as log_fp:
        proc = subprocess.Popen(
            ssh_cmd,
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
            
            # Extract tunnel URL from json line or text
            url_match = re.search(r'https://[a-zA-Z0-9.-]*\.lhr\.life', line)
            if url_match:
                url = url_match.group(0).strip()
                URL_FILE.write_text(url)
                print(f"[Tunnel] Active public endpoint: {url}", flush=True)
            elif line.startswith("{"):
                try:
                    data = json.loads(line)
                    raw = data.get("data", "")
                    m = re.search(r'https://[a-zA-Z0-9.-]*\.lhr\.life', raw)
                    if m:
                        url = m.group(0).strip()
                        URL_FILE.write_text(url)
                        print(f"[Tunnel] Active public endpoint: {url}", flush=True)
                except Exception:
                    pass
        
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try: proc.kill()
            except Exception: pass

print("[Tunnel] Starting persistent SSH tunnel daemon...", flush=True)
while running:
    try:
        run_tunnel()
    except Exception as e:
        print(f"[Tunnel] Error: {e}", flush=True)
    if running:
        print("[Tunnel] Connection lost, reconnecting in 3 seconds...", flush=True)
        time.sleep(3)

PID_FILE.unlink(missing_ok=True)
print("[Tunnel] Stopped.", flush=True)
