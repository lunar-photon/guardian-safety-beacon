#!/usr/bin/env bash
# ============================================================================
# Guardian & Stratus: Self-Contained Interactive Master Installer
# Sets up the entire system, prompts for the permanent tunnel method,
# compiles the APK, installs the global 'sshlocation' command, and launches tracking.
# ============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$DIR/server"
DATA_DIR="$SERVER_DIR/data"
CONFIG_FILE="$DATA_DIR/tunnel.config"
WEATHER_DIR="$DIR/weather"
TOKEN_FILE="$SERVER_DIR/.safety_token"
get_free_port() {
    python3 -c "import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(('', 0))
print(s.getsockname()[1])
s.close()" 2>/dev/null || echo 0
}

mkdir -p "$DATA_DIR"
if [ ! -w "$DATA_DIR" ] || ([ -f "$CONFIG_FILE" ] && [ ! -w "$CONFIG_FILE" ]); then
    if command -v sudo >/dev/null 2>&1; then
        sudo -n chown -R "$(id -u):$(id -g)" "$DATA_DIR" 2>/dev/null || true
    fi
    chmod -R u+w "$DATA_DIR" 2>/dev/null || true
fi

# Detect available port: reuse running server port or pick whatever port is free on this device
if [ -z "$PORT" ] && [ -f "$DATA_DIR/server.port" ] && [ -s "$DATA_DIR/server.port" ]; then
    SAVED_PORT="$(cat "$DATA_DIR/server.port" | tr -d '[:space:]')"
    if [ -n "$SAVED_PORT" ] && curl -s "http://127.0.0.1:$SAVED_PORT/api/session" >/dev/null 2>&1; then
        PORT="$SAVED_PORT"
    fi
fi

if [ -z "$PORT" ] || [ "$PORT" -eq 0 ]; then
    PORT="$(get_free_port)"
fi

echo "$PORT" > "$DATA_DIR/server.port" 2>/dev/null || true
export PORT

echo "=================================================="
echo "  Guardian & Stratus: Master Setup & Installer    "
echo "=================================================="
echo ""

# ----------------------------------------------------------------------------
# 1. Interactive Tunnel Method Selection
# ----------------------------------------------------------------------------
echo "Choose your permanent connection method:"
echo "  1) Serveo (Native SSH - 100% Free, permanent custom subdomain that never changes) [Recommended]"
echo "  2) Ngrok (Dedicated Free Static Domain - e.g. your-name.ngrok-free.app)"
echo "  3) localhost.run (Native SSH - instant setup, dynamic URL)"
echo "  4) Local Network Only (Wi-Fi / LAN only, no public internet access)"
echo ""

DEFAULT_CHOICE="1"
if [ -t 0 ]; then
    read -r -p "Enter choice [1/2/3/4] (default: 1): " USER_CHOICE
else
    USER_CHOICE=""
fi
USER_CHOICE="${USER_CHOICE:-$DEFAULT_CHOICE}"

SELECTED_METHOD="serveo"
SERVEO_SUBDOMAIN=""
NGROK_TOKEN=""
NGROK_DOMAIN=""

case "$USER_CHOICE" in
    1)
        SELECTED_METHOD="serveo"
        echo ""
        echo "Configuring Serveo Permanent Subdomain:"
        DEFAULT_SUB="stratus-$(whoami 2>/dev/null || echo "guardian")"
        if [ -t 0 ]; then
            read -r -p "  Enter desired subdomain (default: $DEFAULT_SUB): " SERVEO_SUBDOMAIN
        fi
        SERVEO_SUBDOMAIN="${SERVEO_SUBDOMAIN:-$DEFAULT_SUB}"
        echo ""
        echo "Notice: To permanently reserve '$SERVEO_SUBDOMAIN.serveo.net' to your laptop,"
        echo "open this 1-time link to sign in with Google or GitHub:"
        echo "  https://console.serveo.net/ssh/keys?add=SHA256%3A4AitATzcdzv0Wh0VTsAFFW7q7j6nlSPc7%2FKMXUHIvCw"
        echo ""
        ;;
    2)
        SELECTED_METHOD="ngrok"
        echo ""
        echo "Configuring Ngrok Dedicated Static Domain:"
        if [ -t 0 ]; then
            read -r -p "  Enter your Ngrok Authtoken: " NGROK_TOKEN
            read -r -p "  Enter your static domain (e.g. name.ngrok-free.app): " NGROK_DOMAIN
        fi
        ;;
    3)
        SELECTED_METHOD="localhost.run"
        echo "Selected localhost.run (Dynamic SSH Reverse Tunnel)."
        ;;
    4)
        SELECTED_METHOD="local"
        echo "Selected Local Network Only mode."
        ;;
    *)
        SELECTED_METHOD="serveo"
        SERVEO_SUBDOMAIN="stratus-$(whoami 2>/dev/null || echo "guardian")"
        ;;
esac

# Save configuration
rm -f "$CONFIG_FILE" 2>/dev/null || true
cat > "$CONFIG_FILE" << EOF
METHOD=$SELECTED_METHOD
SERVEO_SUBDOMAIN=$SERVEO_SUBDOMAIN
NGROK_TOKEN=$NGROK_TOKEN
NGROK_DOMAIN=$NGROK_DOMAIN
PORT=$PORT
EOF

echo "[1/6] Configuration saved to server/data/tunnel.config."

# ----------------------------------------------------------------------------
# 2. Python Virtual Environment & Dependencies
# ----------------------------------------------------------------------------
if [ -d "$SERVER_DIR/.venv" ] && { [ ! -f "$SERVER_DIR/.venv/bin/python" ] || [ ! -f "$SERVER_DIR/.venv/bin/pip" ]; }; then
    echo "[2/6] Cleaning incomplete virtual environment..."
    rm -rf "$SERVER_DIR/.venv"
fi

if [ ! -d "$SERVER_DIR/.venv" ]; then
    echo "[2/6] Setting up Python virtual environment..."
    if ! python3 -m venv "$SERVER_DIR/.venv" 2>/dev/null; then
        echo "[2/6] Standard venv creation failed (ensurepip may be absent). Trying --without-pip bootstrap..."
        rm -rf "$SERVER_DIR/.venv"
        if python3 -m venv --without-pip "$SERVER_DIR/.venv" 2>/dev/null; then
            if command -v curl >/dev/null 2>&1; then
                curl -sS https://bootstrap.pypa.io/get-pip.py | "$SERVER_DIR/.venv/bin/python" - --quiet 2>/dev/null || true
            elif command -v wget >/dev/null 2>&1; then
                wget -qO- https://bootstrap.pypa.io/get-pip.py | "$SERVER_DIR/.venv/bin/python" - --quiet 2>/dev/null || true
            fi
        fi
    fi

    if [ ! -f "$SERVER_DIR/.venv/bin/pip" ]; then
        PY_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "3")"
        echo ""
        echo "Error: Python venv/pip package is missing on your system."
        echo "On Debian/Ubuntu systems, install the required packages with:"
        echo "    sudo apt update && sudo apt install -y python${PY_VER}-venv python3-pip"
        echo "After installing, re-run ./install.sh."
        echo ""
        rm -rf "$SERVER_DIR/.venv"
        exit 1
    fi

    "$SERVER_DIR/.venv/bin/pip" install --quiet --upgrade pip 2>/dev/null || true
    "$SERVER_DIR/.venv/bin/pip" install --quiet -r "$SERVER_DIR/requirements.txt"
else
    echo "[2/6] Python virtual environment ready."
    "$SERVER_DIR/.venv/bin/pip" install --quiet -r "$SERVER_DIR/requirements.txt"
fi

# ----------------------------------------------------------------------------
# 3. Security Token & Database
# ----------------------------------------------------------------------------
if [ ! -f "$TOKEN_FILE" ] || [ ! -s "$TOKEN_FILE" ]; then
    echo "[3/6] Generating security token..."
    python3 -c "import secrets; print(secrets.token_urlsafe(24))" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
else
    echo "[3/6] Safety token present."
fi
TOKEN="$(cat "$TOKEN_FILE" | tr -d '[:space:]')"

# ----------------------------------------------------------------------------
# 4. Start Server & Connect Tunnel
# ----------------------------------------------------------------------------
echo "[4/6] Starting server and connecting tunnel..."
pkill -f "PORT=$PORT .*app.py" 2>/dev/null || true
setsid bash -c "cd '$SERVER_DIR' && SAFETY_TOKEN='$TOKEN' PORT=$PORT ./.venv/bin/python app.py >> server.log 2>&1" </dev/null >/dev/null 2>&1 &

for i in {1..25}; do
    if curl -s "http://127.0.0.1:$PORT/api/session" > /dev/null 2>&1; then
        break
    fi
    sleep 0.4
done

# Connect tunnel
PUBLIC_URL=""
if [ "$SELECTED_METHOD" == "local" ]; then
    echo "Running on local network."
else
    pkill -f "tunnel_daemon.py" 2>/dev/null || true
    pkill -f "nokey@localhost.run" 2>/dev/null || true
    pkill -f "serveo.net" 2>/dev/null || true
    rm -f "$DATA_DIR/tunnel.url"
    PORT=$PORT setsid python3 "$DIR/tools/tunnel_daemon.py" >> "$DATA_DIR/ssh_daemon.log" 2>&1 &
    echo $! > "$DATA_DIR/ssh_tunnel.pid"

    for i in {1..30}; do
        if [ -f "$DATA_DIR/tunnel.url" ] && [ -s "$DATA_DIR/tunnel.url" ]; then
            PUBLIC_URL="$(cat "$DATA_DIR/tunnel.url")/?token=$TOKEN"
            break
        fi
        sleep 0.4
    done
fi

# ----------------------------------------------------------------------------
# 5. Compile Stratus APK
# ----------------------------------------------------------------------------
echo "[5/6] Building Android APK (Stratus.apk)..."
bash "$WEATHER_DIR/build.sh"

# ----------------------------------------------------------------------------
# 6. Install Global 'sshlocation' Command
# ----------------------------------------------------------------------------
echo "[6/6] Installing global 'sshlocation' command..."
chmod +x "$DIR/sshlocation"
mkdir -p "$HOME/.local/bin"
ln -sf "$DIR/sshlocation" "$HOME/.local/bin/sshlocation"

LOCAL_URL="http://localhost:$PORT/?token=$TOKEN"

echo ""
echo "=================================================="
echo "  Installation & Setup Complete!                  "
echo "=================================================="
echo "Local Dashboard  : $LOCAL_URL"
if [ -n "$PUBLIC_URL" ]; then
    echo "Public Tracking  : $PUBLIC_URL"
fi
echo "APK Location     : $HOME/Downloads/Stratus.apk"
echo "Tunnel Method    : $SELECTED_METHOD"
echo "Hosting Mode     : Continuous & Permanent (Never expires)"
echo ""
echo "From now on, whenever your laptop is on, simply run:"
echo "  sshlocation          - Start service & open live tracking"
echo "  sshlocation status   - View live URLs and tracking status"
echo "  sshlocation stop     - Stop service"
echo "  sshlocation rebuild  - Recompile APK with current endpoint"
echo "=================================================="
echo ""

# Open tracking webpage
if which xdg-open > /dev/null 2>&1; then
    xdg-open "$LOCAL_URL" > /dev/null 2>&1 || true
elif which python3 > /dev/null 2>&1; then
    python3 -m webbrowser "$LOCAL_URL" > /dev/null 2>&1 || true
fi
