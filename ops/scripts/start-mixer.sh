#!/bin/bash
# Mixer server launcher. Used by PM2 (tonel-mixer).
# `cd` ensures recordings/ relative paths land under TONEL_RUNTIME_DIR.
set -euo pipefail

TONEL_ROOT="${TONEL_ROOT:-/opt/tonel}"
TONEL_RUNTIME_DIR="${TONEL_RUNTIME_DIR:-/var/lib/tonel}"

mkdir -p "$TONEL_RUNTIME_DIR/recordings"
cd "$TONEL_RUNTIME_DIR"

exec "$TONEL_ROOT/bin/mixer_server" 9002 9003
