#!/usr/bin/env bash
# Start the Guardian server. Usage:  SAFETY_TOKEN=your-secret ./run.sh
set -e
cd "$(dirname "$0")"

if [ -d .venv ] && { [ ! -f .venv/bin/python ] || [ ! -f .venv/bin/pip ]; }; then
  echo "Cleaning incomplete virtual environment..."
  rm -rf .venv
fi

if [ ! -d .venv ]; then
  echo "Creating virtualenv + installing deps..."
  if ! python3 -m venv .venv 2>/dev/null; then
    echo "Standard venv creation failed (ensurepip may be absent). Trying --without-pip bootstrap..."
    rm -rf .venv
    if python3 -m venv --without-pip .venv 2>/dev/null; then
      if command -v curl >/dev/null 2>&1; then
        curl -sS https://bootstrap.pypa.io/get-pip.py | .venv/bin/python - --quiet 2>/dev/null || true
      elif command -v wget >/dev/null 2>&1; then
        wget -qO- https://bootstrap.pypa.io/get-pip.py | .venv/bin/python - --quiet 2>/dev/null || true
      fi
    fi
  fi

  if [ ! -f .venv/bin/pip ]; then
    PY_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "3")"
    echo ""
    echo "Error: Python venv/pip package is missing on your system."
    echo "On Debian/Ubuntu systems, install the required packages with:"
    echo "    sudo apt update && sudo apt install -y python${PY_VER}-venv python3-pip"
    echo "After installing, re-run this script."
    echo ""
    rm -rf .venv
    exit 1
  fi

  ./.venv/bin/pip install -q -r requirements.txt
fi

get_free_port() {
  python3 -c "import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(('', 0))
print(s.getsockname()[1])
s.close()" 2>/dev/null || echo 8000
}

if [ -z "$PORT" ]; then
  mkdir -p data
  if [ -f data/server.port ] && [ -s data/server.port ]; then
    SAVED_PORT="$(cat data/server.port | tr -d '[:space:]')"
    if [ -n "$SAVED_PORT" ] && curl -s "http://127.0.0.1:$SAVED_PORT/api/session" >/dev/null 2>&1; then
      PORT="$SAVED_PORT"
    fi
  fi
  if [ -z "$PORT" ]; then
    PORT="$(get_free_port)"
  fi
fi

export PORT
mkdir -p data
echo "$PORT" > data/server.port

echo "Starting Guardian on http://0.0.0.0:${PORT}"
echo "Dashboard:  http://localhost:${PORT}/"
echo "Phone app:  http://localhost:${PORT}/pwa/   (use the ngrok URL on the phone)"
echo
exec ./.venv/bin/python app.py
