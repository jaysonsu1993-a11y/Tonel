#!/bin/bash
# run.sh — start a local mixer, run the audio quality e2e test, tear down.
#
# Usage:
#   server/test/run.sh                 # default 1 kHz / 0.3 amp / 1 s
#   server/test/run.sh --freq 440 --amp 0.5 --seconds 2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="$SERVER_DIR/build/mixer_server"

[ -x "$BIN" ] || { echo "[run] mixer_server not built — run cmake --build $SERVER_DIR/build" >&2; exit 2; }

TCP=19002
UDP=19003

# Free the ports if a previous test left a stuck process behind.
for P in "$TCP" "$UDP"; do
  PID=$(lsof -nP -iTCP:"$P" -iUDP:"$P" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u || true)
  [ -z "$PID" ] || { echo "[run] killing stuck pid=$PID on port $P"; kill -9 $PID 2>/dev/null || true; }
done

LOG="$(mktemp -t tonel-mixer.XXXXXX.log)"
"$BIN" "$TCP" "$UDP" >"$LOG" 2>&1 &
MIXER_PID=$!
trap 'kill -TERM $MIXER_PID 2>/dev/null; wait $MIXER_PID 2>/dev/null; echo "[run] mixer log: $LOG"' EXIT

# Wait for mixer to be listening (≤ 2s).
for _ in $(seq 1 20); do
  if nc -z 127.0.0.1 "$TCP" 2>/dev/null; then break; fi
  sleep 0.1
done
nc -z 127.0.0.1 "$TCP" 2>/dev/null || { echo "[run] mixer never opened TCP $TCP" >&2; cat "$LOG" >&2; exit 2; }

echo "[run] mixer pid=$MIXER_PID, TCP=$TCP, UDP=$UDP, log=$LOG"
echo ""

node "$SCRIPT_DIR/audio_quality_e2e.js" --tcp "$TCP" --udp "$UDP" "$@"
EXIT=$?

echo ""
echo "[run] mixer last 20 log lines:"
tail -n 20 "$LOG" | sed 's/^/    /'

exit $EXIT
