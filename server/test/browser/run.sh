#!/bin/bash
# run.sh — Browser-side audio quality test wrapper.
#
# Loads the production playback worklet code (kept in sync inside
# test_page.html) into a real Chromium via Playwright, feeds known
# PCM frames, captures the rendered output, computes SNR/THD.
#
# Covers what the Node SPA1 test does NOT: AudioWorklet behaviour,
# resampling, ring-buffer dynamics under different AudioContext rates.
#
# Usage:
#   server/test/browser/run.sh                    # default (1 kHz, amp=0.3)
#   server/test/browser/run.sh --amp 0.05         # small amplitude
#   server/test/browser/run.sh --rate 44100       # only 44.1 kHz context
#   server/test/browser/run.sh --headed           # visible browser

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

[ -d node_modules/playwright ] || { echo "[run] installing deps..."; npm install --no-fund --no-audit; }

# Make sure chromium is available.
if [ ! -d "$HOME/Library/Caches/ms-playwright" ] && [ ! -d "$HOME/.cache/ms-playwright" ]; then
  echo "[run] installing chromium..."
  npx playwright install chromium
fi

node browser_audio_test.js "$@"
