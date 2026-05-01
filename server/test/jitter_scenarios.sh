#!/usr/bin/env bash
# jitter_scenarios.sh — sweep sender-side jitter against the current
# mixer_server build and emit one TSV row per scenario.
#
# Use this to validate jitter-buffer / PLC changes locally:
#   1. Run on the baseline you want to compare against (e.g. before a fix).
#   2. Make the change, rebuild.
#   3. Run again. Diff the rows.
#
# Columns:
#   signal  freq  amp  seconds  jitterSd  burstEvery  burstHoldMs
#   snr_dB  thd_pct  rate_ppm
#   plc_packets  plc_per_s  priming_ticks
#   click_count  click_rate  click_norm_energy
#   pass
#
# Pipe to `column -t` for human reading or to a file for diffing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="$SERVER_DIR/build/mixer_server"
TCP=19002
UDP=19003
SECONDS_OPT=${SECONDS_OPT:-5}
AMP=${AMP:-0.30}

[ -x "$BIN" ] || { echo "mixer_server not built — run cmake --build $SERVER_DIR/build" >&2; exit 2; }

# Free the ports if a previous test left a stuck process behind.
for P in "$TCP" "$UDP"; do
  PID=$(lsof -nP -iTCP:"$P" -iUDP:"$P" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u || true)
  [ -z "$PID" ] || kill -9 $PID 2>/dev/null || true
done

LOG=$(mktemp -t tonel-mixer.XXXXXX.log)
"$BIN" "$TCP" "$UDP" >"$LOG" 2>&1 &
MIXER_PID=$!
trap 'kill -TERM $MIXER_PID 2>/dev/null; wait $MIXER_PID 2>/dev/null' EXIT

# Wait for mixer to be listening (≤ 2 s).
for _ in $(seq 1 20); do
  nc -z 127.0.0.1 "$TCP" 2>/dev/null && break
  sleep 0.1
done
nc -z 127.0.0.1 "$TCP" 2>/dev/null || { echo "mixer never opened TCP $TCP" >&2; cat "$LOG" >&2; exit 2; }

run_one() {
    node "$SCRIPT_DIR/audio_quality_e2e.js" \
        --tcp "$TCP" --udp "$UDP" \
        --seconds "$SECONDS_OPT" --amp "$AMP" \
        --summary csv "$@" 2>/dev/null
}

# Header
printf 'signal\tfreq\tamp\tseconds\tjitterSd\tburstEvery\tburstHoldMs\tsnr_dB\tthd_pct\trate_ppm\tplc_packets\tplc_per_s\tpriming_ticks\tclick_count\tclick_rate\tnorm_energy\tpass\n'

# Voice + Gaussian jitter sweep
for sd in 0 2 5 10 15 20; do
    run_one --signal voice --freq 200 --jitterSd "$sd"
done

# Voice + burst patterns (every K frames, hold the queue then release —
# simulates main-thread stall + recovery on the WSS-over-TCP path)
for params in "20:15" "10:20" "20:30"; do
    every="${params%:*}"
    hold="${params#*:}"
    run_one --signal voice --freq 200 --burstEvery "$every" --burstHoldMs "$hold"
done

# Sine baseline at three amplitudes (regression guard for the no-jitter,
# fundamental-tone path that Layer 1 traditionally guarded — SNR/THD
# pass should stay at the baseline numbers in audio_quality_e2e.js).
for amp in 0.05 0.30 0.95; do
    AMP="$amp" run_one --signal sine --amp "$amp"
done
