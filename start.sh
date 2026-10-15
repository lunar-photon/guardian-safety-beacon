#!/usr/bin/env bash
# ============================================================================
# Guardian & Stratus: Master Entry Point
# Automatically routes to install.sh on first run, or sshlocation to start tracking.
# ============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$DIR/server/data/tunnel.config" ]; then
    exec "$DIR/install.sh" "$@"
else
    exec "$DIR/sshlocation" "$@"
fi
