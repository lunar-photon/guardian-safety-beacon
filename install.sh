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
WEATHER_DIR="$DIR/weather"
TOKEN_FILE="$SERVER_DIR/.safety_token"
CONFIG_FILE="$DATA_DIR/tunnel.config"
PORT=8000

mkdir -p "$DATA_DIR"

echo "=================================================="
echo "  Guardian & Stratus: Master Setup & Installer    "
echo "=================================================="
echo ""

# ----------------------------------------------------------------------------
# 1. Interactive Tunnel Method Selection
# ----------------------------------------------------------------------------
echo "Choose your permanent connection method:"
echo "  1) localhost.run (SSH Reverse Tunnel - Native SSH, zero setup, stays active whenever laptop is on) [Recommended]"
echo "  2) Cloudflare Named Tunnel (Permanent 24/7 tunnel - requires your Cloudflare Tunnel Token & domain)"
echo "  3) Local Network Only (Wi-Fi / LAN only, no public internet access)"
echo ""

DEFAULT_CHOICE="1"
if [ -t 0 ]; then
    read -r -p "Enter choice [1/2/3] (default: 1): " USER_CHOICE
else
    USER_CHOICE=""
fi
USER_CHOICE="${USER_CHOICE:-$DEFAULT_CHOICE}"

SELECTED_METHOD="localhost.run"
CF_TOKEN=""
CF_DOMAIN=""

case "$USER_CHOICE" in
    2)
        SELECTED_METHOD="cloudflare"
        echo ""
        echo "Configuring Cloudflare Named Tunnel:"
        if [ -t 0 ]; then
            read -r -p "  Enter your Cloudflare Tunnel Token: " CF_TOKEN
            read -r -p "  Enter your configured domain (e.g. track.example.com): " CF_DOMAIN
        fi
        ;;
    3)
        SELECTED_METHOD="local"
        echo "Selected Local Network Only mode."
        ;;
    *)
        SELECTED_METHOD="localhost.run"
        echo "Selected localhost.run (Native SSH Reverse Tunnel)."
        ;;
esac

# Save configuration
cat > "$CONFIG_FILE" << EOF
METHOD=$SELECTED_METHOD
CF_TOKEN=$CF_TOKEN
CF_DOMAIN=$CF_DOMAIN
EOF

echo "[1/6] Configuration saved to server/data/tunnel.config."

# ----------------------------------------------------------------------------
# 2. Python Virtual Environment & Dependencies
# ----------------------------------------------------------------------------
if [ ! -d "$SERVER_DIR/.venv" ]; then
    echo "[2/6] Setting up Python virtual environment..."
    python3 -m venv "$SERVER_DIR/.venv"
    "$SERVER_DIR/.venv/bin/pip" install --quiet --upgrade pip
    "$SERVER_DIR/.venv/bin/pip" install --quiet -r "$SERVER_DIR/requirements.txt"
else
    echo "[2/6] Python virtual environment ready."
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
(
    cd "$SERVER_DIR"
    SAFETY_TOKEN="$TOKEN" PORT=$PORT ./.venv/bin/python app.py >> server.log 2>&1
) &

for i in {1..25}; do
    if curl -s "http://127.0.0.1:$PORT/api/session" > /dev/null 2>&1; then
        break
    fi
    sleep 0.4
done

# Renew session
curl -s -X POST "http://127.0.0.1:$PORT/api/session/renew" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"hours": 24}' > /dev/null 2>&1 || true

# Connect tunnel
PUBLIC_URL=""
if [ "$SELECTED_METHOD" == "cloudflare" ] && [ -n "$CF_TOKEN" ]; then
    CLOUDFLARED="$HOME/.local/bin/cloudflared"
    [ -x "$CLOUDFLARED" ] || CLOUDFLARED="$(which cloudflared || true)"
    if [ -x "$CLOUDFLARED" ]; then
        pkill -f "cloudflared tunnel run" 2>/dev/null || true
        "$CLOUDFLARED" tunnel run --token "$CF_TOKEN" > "$DATA_DIR/cf_tunnel.log" 2>&1 &
        echo $! > "$DATA_DIR/cf_tunnel.pid"
        if [ -n "$CF_DOMAIN" ]; then
            PUBLIC_URL="https://$CF_DOMAIN/?token=$TOKEN"
            echo "https://$CF_DOMAIN" > "$DATA_DIR/tunnel.url"
        fi
    fi
elif [ "$SELECTED_METHOD" == "localhost.run" ]; then
    SSH_LOG="$DATA_DIR/ssh_tunnel.log"
    rm -f "$SSH_LOG"
    pkill -f "nokey@localhost.run" 2>/dev/null || true
    ssh -o StrictHostKeyChecking=no \
        -o ServerAliveInterval=30 \
        -o ServerAliveCountMax=3 \
        -o ExitOnForwardFailure=yes \
        -R 80:localhost:$PORT nokey@localhost.run > "$SSH_LOG" 2>&1 &
    echo $! > "$DATA_DIR/ssh_tunnel.pid"

    for i in {1..30}; do
        DETECTED=$(grep -o 'https://[a-zA-Z0-9.-]*\.lhr\.life' "$SSH_LOG" | head -n 1 || true)
        if [ -n "$DETECTED" ]; then
            echo "$DETECTED" > "$DATA_DIR/tunnel.url"
            PUBLIC_URL="$DETECTED/?token=$TOKEN"
            break
        fi
        sleep 0.5
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
cp "$DIR/sshlocation" "$HOME/.local/bin/sshlocation"

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
echo "Session Expiry   : Active for 24 hours (links return 404 when expired)"
echo ""
echo "From now on, whenever your laptop is on, simply run:"
echo "  sshlocation          - Start service & open live tracking"
echo "  sshlocation status   - View live URLs and tracking status"
echo "  sshlocation stop     - Stop service & tunnel (links return 404)"
echo "  sshlocation rebuild  - Recompile APK with current endpoint"
echo "=================================================="
echo ""

# Open tracking webpage
if which xdg-open > /dev/null 2>&1; then
    xdg-open "$LOCAL_URL" > /dev/null 2>&1 || true
elif which python3 > /dev/null 2>&1; then
    python3 -m webbrowser "$LOCAL_URL" > /dev/null 2>&1 || true
fi
