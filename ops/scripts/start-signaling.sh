#!/bin/bash
# Signaling server launcher. Kept for parity with start-mixer.sh; PM2 invokes
# the binary directly, but this script is useful for manual debugging.
set -euo pipefail

TONEL_ROOT="${TONEL_ROOT:-/opt/tonel}"
exec "$TONEL_ROOT/bin/signaling_server" 9001
