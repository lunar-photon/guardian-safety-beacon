#!/usr/bin/env bash
# Start the Guardian server. Usage:  SAFETY_TOKEN=your-secret ./run.sh
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating virtualenv + installing deps..."
  python3 -m venv .venv
  ./.venv/bin/pip install -q -r requirements.txt
fi

: "${PORT:=8000}"
echo "Starting Guardian on http://0.0.0.0:${PORT}"
echo "Dashboard:  http://localhost:${PORT}/"
echo "Phone app:  http://localhost:${PORT}/pwa/   (use the ngrok URL on the phone)"
echo
exec ./.venv/bin/python app.py
