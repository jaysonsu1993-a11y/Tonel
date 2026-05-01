#!/bin/bash
# pretest.sh — pre-release safety gate.
#
# Runs every test layer that does NOT require a deployed environment.
# Intended to be called by scripts/release.sh BEFORE the version
# bump / commit / tag / deploy. Any failure aborts the release —
# better to catch a regression on the developer's laptop than to ship
# it and roll back.
#
# Layers (in order, ascending cost):
#
#   1. Server build + AudioMixer unit tests       (~2–4 s)
#   2. Layer 1 audio quality (Node + sine wave)   (~3–5 s)
#   3. Layer 1.5 jitter / PLC sweep               (~70 s — 12 scenarios × ~5 s)
#   4. Signaling integration test (Node)          (~2–4 s)  ← v3.6.2 regression coverage
#   5. Layer 2 browser audio (Playwright/Chromium)(~25 s first time, ~10 s after)
#   6. State migration (Vite + Playwright)        (~10 s)   ← v4.1.2 regression coverage
#
# Layers 1–4 + 6 are deterministic; layer 5 has been observed to flake on
# the very first invocation (Chromium not yet warm). The runner gives
# layer 5 one auto-retry before declaring failure.
#
# Usage:
#   scripts/pretest.sh                        # full suite
#   SKIP_L2=1 scripts/pretest.sh              # skip browser audio (e.g. headless server)
#   SKIP_MIGRATION=1 scripts/pretest.sh       # skip state migration (e.g. dev iteration)
#
# Used by:
#   scripts/release.sh — inserted as step [0/6] before bump.
#   Manually by the developer when validating a branch.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -t 1 ]; then
    C_BLD=$'\033[1m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_RED=$'\033[31m'; C_RST=$'\033[0m'
else
    C_BLD=; C_GRN=; C_YEL=; C_RED=; C_RST=
fi
log()  { printf '%s[pretest]%s %s\n' "$C_BLD" "$C_RST" "$*"; }
ok()   { printf '%s[pretest]%s %s%s%s\n' "$C_BLD" "$C_RST" "$C_GRN" "$*" "$C_RST"; }
warn() { printf '%s[pretest]%s %s%s%s\n' "$C_BLD" "$C_RST" "$C_YEL" "$*" "$C_RST" >&2; }
die()  { printf '%s[pretest]%s %sFAIL:%s %s\n' "$C_BLD" "$C_RST" "$C_RED" "$C_RST" "$*" >&2; exit 1; }

# Run a step; on failure, dump its captured stdout+stderr so the user
# can see WHAT broke, then exit. Intentionally a single output sink
# (`tee` into a temp log) so we can show it even on success if a
# downstream step needs the prior context.
run_step () {
    local name="$1"; shift
    log "─── $name ───"
    if "$@"; then
        ok "$name passed"
    else
        die "$name failed"
    fi
}

# Same but with one auto-retry. Used for L2 (Chromium first-time flake).
run_step_retry () {
    local name="$1"; shift
    log "─── $name ───"
    if "$@"; then
        ok "$name passed"
    else
        warn "$name failed first run — retrying once"
        if "$@"; then
            ok "$name passed (on retry)"
        else
            die "$name failed twice"
        fi
    fi
}

# ── 1. Server build + AudioMixer unit tests ───────────────────────────────

run_step "1/6 server build (cmake)" \
    cmake --build "$REPO_ROOT/server/build"

# AudioMixer tests are deterministic, no audio device needed.
run_step "1b/6 AudioMixer unit tests" \
    "$REPO_ROOT/server/build/mixer_server" --test

# ── 2. Layer 1 — Node SPA1 audio quality ──────────────────────────────────

# Layer 1 — capture output, grade by the literal '[test] PASS' line.
# run.sh's wrapper exits 143 even on test pass (it SIGTERMs the spawned
# mixer and doesn't suppress that into 0), so we can't rely on the
# wrapper exit code alone.
run_layer1 () {
    local out
    out=$("$REPO_ROOT/server/test/run.sh" 2>&1 || true)
    if echo "$out" | grep -q '^\[test\] PASS'; then
        echo "$out" | grep -E "(SNR|THD|^\[test\] (PASS|FAIL))" | head -5
        return 0
    fi
    echo "$out"
    return 1
}
# Layer 1 has a broadcast-rate-drift check with a ±5 000 ppm budget;
# under main-thread load the measured rate can briefly exceed budget
# even when the server timer is fine. Treat that as flake — one
# auto-retry, same pattern as Layer 2.
run_step_retry "2/6 Layer 1 (1 kHz sine SNR/THD)" run_layer1

# Layer 1.5 — show TSV always (cheap, useful), grade by last column.
run_layer15 () {
    local out
    out=$("$REPO_ROOT/server/test/jitter_scenarios.sh")
    echo "$out" | column -t
    local bad
    bad=$(echo "$out" | tail -n +2 | awk '{ if ($NF != "PASS") print }')
    if [ -n "$bad" ]; then
        echo "    FAIL rows:"; echo "$bad" | sed 's/^/      /'
        return 1
    fi
}
run_step "3/6 Layer 1.5 (jitter sweep)" run_layer15

# ── 4. Signaling integration ──────────────────────────────────────────────

run_step "4/6 signaling integration" \
    node "$REPO_ROOT/server/test/signaling_integration.js"

# ── 5. Layer 2 — Browser audio (Chromium) ────────────────────────────────

if [ "${SKIP_L2:-0}" = "1" ]; then
    warn "5/6 Layer 2 skipped (SKIP_L2=1)"
else
    run_step_retry "5/6 Layer 2 (browser audio)" \
        bash "$REPO_ROOT/server/test/browser/run.sh"
fi

# ── 6. State migration — localStorage schema upgrade ─────────────────────
#
# Spawns Vite dev server + Chromium and replays the upgrade path:
# stale tuning blob → migration discard → current defaults applied.
# Added v4.1.2 to catch the regression class where bumping default
# values silently fails for users with a pre-existing localStorage slot.
# Cheap (~10s wall-clock); critical for any change that touches
# DEFAULT_PB / DEFAULT_SRV / TUNING_SCHEMA_VERSION.
if [ "${SKIP_MIGRATION:-0}" = "1" ]; then
    warn "6/6 state migration skipped (SKIP_MIGRATION=1)"
else
    run_step "6/6 state migration (localStorage schema upgrade)" \
        node "$REPO_ROOT/server/test/browser/state_migration_test.js"
fi

ok "all pretest layers passed — safe to release"
