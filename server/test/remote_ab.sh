#!/usr/bin/env bash
# remote_ab.sh — A/B compare audio quality between two production-style
# servers via WSS (browser-equivalent path).
#
# Why this exists: the user reported the new (Guangzhou) server reproduces
# 破音失真 at the same client params where the old (Aliyun) server is
# clean. v1.0.38 fixed a similar symptom by raising JITTER_MAX_DEPTH;
# different network paths can still surface different burst patterns.
# This script generates a deterministic, side-by-side metrics table so
# we can see *where* they diverge instead of guessing.
#
# What it does:
#   1. Runs the same suite of scenarios against each server via
#      audio_quality_e2e.js --mode wss.
#   2. Captures CSV output, joins the two servers row-by-row.
#   3. Prints a column-aligned diff highlighting metrics that diverge.
#
# Use: from repo root
#   server/test/remote_ab.sh
#   server/test/remote_ab.sh --seconds 3                   # longer takes
#   server/test/remote_ab.sh --hostA srv.tonel.io --hostB srv-new.tonel.io
#
# Output rows reference jitter_scenarios.sh's TSV column convention so
# results are diffable against the local-mixer baseline.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_A="${HOST_A:-srv.tonel.io}"        # baseline ("old" / production / Aliyun)
HOST_B="${HOST_B:-srv-new.tonel.io}"    # candidate ("new" / Guangzhou)
SECONDS_PER_RUN=2
MODE="wss"                              # 'wss' or 'wt'

while [ $# -gt 0 ]; do
    case "$1" in
        --hostA)    HOST_A="$2"; shift 2 ;;
        --hostB)    HOST_B="$2"; shift 2 ;;
        --seconds)  SECONDS_PER_RUN="$2"; shift 2 ;;
        --mode)     MODE="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

case "$MODE" in
    wss) HOST_FLAG="--wssHost" ;;
    wt)  HOST_FLAG="--wtHost"  ;;
    *) echo "--mode must be wss or wt (got: $MODE)" >&2; exit 2 ;;
esac

# ─── scenario matrix ────────────────────────────────────────────────────────
# Format:  signal freq amp seconds jitterSd burstEvery burstHoldMs
# (Mirror jitter_scenarios.sh layout. Pure sine baselines anchor SNR/THD;
#  voice rows under varying jitter expose PLC + click behaviour, which is
#  the v1.0.38-class symptom.)
SCENARIOS=(
    # signal freq amp   sec  jitterSd burstEvery burstHoldMs
    "sine    1000 0.05  $SECONDS_PER_RUN  0       0          20"
    "sine    1000 0.30  $SECONDS_PER_RUN  0       0          20"
    "sine    1000 0.95  $SECONDS_PER_RUN  0       0          20"
    "voice   400  0.30  $SECONDS_PER_RUN  0       0          20"
    "voice   400  0.30  $SECONDS_PER_RUN  5       0          20"
    "voice   400  0.30  $SECONDS_PER_RUN  10      0          20"
    "voice   400  0.30  $SECONDS_PER_RUN  15      0          20"
    "voice   400  0.30  $SECONDS_PER_RUN  20      0          20"
    "voice   400  0.30  $SECONDS_PER_RUN  0       20         15"
    "voice   400  0.30  $SECONDS_PER_RUN  0       10         20"
    "voice   400  0.30  $SECONDS_PER_RUN  0       20         30"
)

run_one() {
    local host="$1"
    local sig="$2" freq="$3" amp="$4" sec="$5" jsd="$6" be="$7" bh="$8"
    node "$SCRIPT_DIR/audio_quality_e2e.js" \
        --mode "$MODE" "$HOST_FLAG" "$host" \
        --signal "$sig" --freq "$freq" --amp "$amp" --seconds "$sec" \
        --jitterSd "$jsd" --burstEvery "$be" --burstHoldMs "$bh" \
        --summary csv 2>/dev/null \
        | tail -n 1
}

OUT_A=$(mktemp)
OUT_B=$(mktemp)
trap 'rm -f "$OUT_A" "$OUT_B"' EXIT

# Header shared between both servers; pulled from a probe run that
# csv-mode prints on stdout. Fall back to a hard-coded header if probe
# stays silent (server unreachable).
HEADER=$(node "$SCRIPT_DIR/audio_quality_e2e.js" --mode "$MODE" "$HOST_FLAG" "$HOST_A" \
    --signal sine --freq 1000 --amp 0.05 --seconds 0.5 --summary csv 2>/dev/null \
    | head -n 1 || true)
if [ -z "$HEADER" ]; then
    HEADER="signal	freq	amp	seconds	jitterSd	burstEvery	burstHoldMs	snr_dB	thd_pct	rate_ppm	plc_packets	plc_per_s	priming_ticks	click_count	click_rate	norm_energy	pass"
fi

echo "" > "$OUT_A"
echo "" > "$OUT_B"

echo "[ab] running ${#SCENARIOS[@]} scenarios × 2 servers @ ${SECONDS_PER_RUN}s each — ETA ~$(( ${#SCENARIOS[@]} * SECONDS_PER_RUN * 2 + 10 ))s" >&2
i=0
for row in "${SCENARIOS[@]}"; do
    i=$((i+1))
    read -r sig freq amp sec jsd be bh <<<"$row"
    printf '[ab] %2d/%d  %s/%s/%s  jitter=%s burst=%s/%sms\n' \
        "$i" "${#SCENARIOS[@]}" "$sig" "$freq" "$amp" "$jsd" "$be" "$bh" >&2
    run_one "$HOST_A" "$sig" "$freq" "$amp" "$sec" "$jsd" "$be" "$bh" >> "$OUT_A" || echo "" >> "$OUT_A"
    run_one "$HOST_B" "$sig" "$freq" "$amp" "$sec" "$jsd" "$be" "$bh" >> "$OUT_B" || echo "" >> "$OUT_B"
done

# Combine A | B side-by-side using `paste` and emit a clean column table.
{
    echo -e "server\t$HEADER"
    while IFS= read -r a && IFS= read -r b <&3; do
        [ -z "$a" ] && continue
        echo -e "[A:$HOST_A]\t$a"
        echo -e "[B:$HOST_B]\t$b"
        echo ""
    done < "$OUT_A" 3< "$OUT_B"
} | column -t -s $'\t'

echo
echo "[ab] A=$HOST_A   B=$HOST_B"
echo "[ab] columns to focus on for 破音 diagnosis: snr_dB, thd_pct, plc_per_s, click_rate, norm_energy"
