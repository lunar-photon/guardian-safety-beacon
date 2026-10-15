#!/usr/bin/env bash
# ============================================================================
# Guardian & Stratus: All-In-One Laptop Installer & Tracking Runner
# One command to setup everything, build the Android APK, launch hosting,
# and open live tracking in the browser.
#
# Usage:
#   ./start.sh         - Setup, build APK, start hosting, open tracking
#   ./start.sh stop    - Stop hosting and tunnel (links return 404 Not Found)
#   ./start.sh status  - Check tracking session, tunnel, and phone status
# ============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$DIR/server"
DATA_DIR="$SERVER_DIR/data"
WEATHER_DIR="$DIR/weather"
TOKEN_FILE="$SERVER_DIR/.safety_token"
URL_FILE="$DATA_DIR/cloudflare.url"
PORT=8000

mkdir -p "$DATA_DIR"

# ----------------------------------------------------------------------------
# Command: Stop
# ----------------------------------------------------------------------------
if [ "$1" == "stop" ]; then
    echo "Stopping Guardian hosting and public tunnel..."
    if [ -f "$TOKEN_FILE" ]; then
        TOK="$(cat "$TOKEN_FILE" | tr -d '[:space:]')"
        curl -s -X POST "http://127.0.0.1:$PORT/api/session/end" \
            -H "Authorization: Bearer $TOK" > /dev/null 2>&1 || true
    fi
    pkill -f "cloudflared tunnel --url http://127.0.0.1:$PORT" > /dev/null 2>&1 || true
    pkill -f "PORT=$PORT .*app.py" > /dev/null 2>&1 || true
    echo "Hosting stopped. Tracking links now return 404 Not Found."
    exit 0
fi

# ----------------------------------------------------------------------------
# Command: Status
# ----------------------------------------------------------------------------
if [ "$1" == "status" ]; then
    if [ -f "$TOKEN_FILE" ]; then
        TOK="$(cat "$TOKEN_FILE" | tr -d '[:space:]')"
        echo "Guardian Status:"
        curl -s "http://127.0.0.1:$PORT/api/session" | python3 -m json.tool || echo "Server is offline."
        if [ -f "$URL_FILE" ]; then
            echo "Public Tunnel: $(cat "$URL_FILE")/?token=$TOK"
        fi
    else
        echo "No safety token found. Run ./start.sh first."
    fi
    exit 0
fi

echo "=================================================="
echo "  Guardian & Stratus: Master Installer & Runner   "
echo "=================================================="

# 1. Check Python and setup virtual environment
if [ ! -d "$SERVER_DIR/.venv" ]; then
    echo "[1/5] Creating Python virtual environment..."
    python3 -m venv "$SERVER_DIR/.venv"
    "$SERVER_DIR/.venv/bin/pip" install --quiet --upgrade pip
    "$SERVER_DIR/.venv/bin/pip" install --quiet -r "$SERVER_DIR/requirements.txt"
else
    echo "[1/5] Python virtual environment ready."
fi

# 2. Ensure security token and paired device
if [ ! -f "$TOKEN_FILE" ] || [ ! -s "$TOKEN_FILE" ]; then
    echo "[2/5] Generating safety token..."
    python3 -c "import secrets; print(secrets.token_urlsafe(24))" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
else
    echo "[2/5] Safety token present."
fi
TOKEN="$(cat "$TOKEN_FILE" | tr -d '[:space:]')"

# 3. Start or ensure Server is running
echo "[3/5] Starting Guardian server..."
SERVER_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/session" || echo "000")
if [ "$SERVER_HEALTH" != "200" ]; then
    pkill -f "PORT=$PORT .*app.py" > /dev/null 2>&1 || true
    (
        cd "$SERVER_DIR"
        SAFETY_TOKEN="$TOKEN" PORT=$PORT ./.venv/bin/python app.py >> server.log 2>&1
    ) &
    # Wait for server to become responsive
    for i in {1..20}; do
        if curl -s "http://127.0.0.1:$PORT/api/session" > /dev/null 2>&1; then
            break
        fi
        sleep 0.5
    done
fi

# Renew session for 24 hours
curl -s -X POST "http://127.0.0.1:$PORT/api/session/renew" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"hours": 24}' > /dev/null 2>&1 || true

# 4. Start or ensure Cloudflare Tunnel is running
CLOUDFLARED="$HOME/.local/bin/cloudflared"
if [ ! -x "$CLOUDFLARED" ]; then
    CLOUDFLARED="$(which cloudflared || true)"
fi

if [ -x "$CLOUDFLARED" ]; then
    # Check if existing tunnel is responding
    ACTIVE_TUNNEL=""
    if [ -f "$URL_FILE" ]; then
        CANDIDATE="$(cat "$URL_FILE" | tr -d '[:space:]')"
        STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$CANDIDATE/api/session" || echo "000")
        if [ "$STATUS_CODE" == "200" ]; then
            ACTIVE_TUNNEL="$CANDIDATE"
        fi
    fi

    if [ -z "$ACTIVE_TUNNEL" ]; then
        echo "[4/5] Launching secure public tunnel..."
        pkill -f "cloudflared tunnel --url http://127.0.0.1:$PORT" > /dev/null 2>&1 || true
        LOG="$DATA_DIR/cloudflared.log"
        "$CLOUDFLARED" tunnel --url "http://127.0.0.1:$PORT" > "$LOG" 2>&1 &
        TUNNEL_PID=$!
        
        # Wait for tunnel URL
        for i in {1..30}; do
            URL=$(grep -o 'https://[-a-z0-9.]*\.trycloudflare\.com' "$LOG" | head -n 1 || true)
            if [ -n "$URL" ]; then
                echo "$URL" > "$URL_FILE"
                ACTIVE_TUNNEL="$URL"
                break
            fi
            sleep 0.5
        done
    else
        echo "[4/5] Existing tunnel is healthy: $ACTIVE_TUNNEL"
    fi
else
    echo "[4/5] Notice: cloudflared not found; using local network tracking."
fi

# 5. Build Stratus APK with active tunnel URL patched in
echo "[5/5] Building Android APK (Stratus.apk)..."
bash "$WEATHER_DIR/build.sh"

LOCAL_URL="http://localhost:$PORT/?token=$TOKEN"
PUBLIC_URL=""
if [ -f "$URL_FILE" ]; then
    PUBLIC_URL="$(cat "$URL_FILE")/?token=$TOKEN"
fi

echo ""
echo "=================================================="
echo "  Setup & Build Complete!                         "
echo "=================================================="
echo "Local Dashboard : $LOCAL_URL"
if [ -n "$PUBLIC_URL" ]; then
    echo "Public Tracking : $PUBLIC_URL"
fi
echo "APK Location    : $HOME/Downloads/Stratus.apk"
echo "Session Expiry  : Active for 24 hours (links return 404 when expired)"
echo "To stop hosting : ./start.sh stop"
echo "=================================================="
echo ""

# Open tracking webpage in default browser
if which xdg-open > /dev/null 2>&1; then
    xdg-open "$LOCAL_URL" > /dev/null 2>&1 || true
elif which python3 > /dev/null 2>&1; then
    python3 -m webbrowser "$LOCAL_URL" > /dev/null 2>&1 || true
fi
