#!/bin/bash
# Upload an artifact to the tonel-downloads R2 bucket.
#
# Usage:    deploy/upload-r2.sh <local-file> [remote-name]
# Example:  deploy/upload-r2.sh deploy/dist/Tonel-MacOS-v6.5.2.dmg
#           deploy/upload-r2.sh ~/Downloads/Tonel-Setup.exe Tonel-Windows-v6.5.2.exe
#
# Bucket:   tonel-downloads
# Public:   https://download.tonel.io/<remote-name>
#
# Also publishes a `*-latest.{dmg,exe}` alias so the web home page can
# link to a stable URL across releases without a GitHub Actions
# pipeline.
#
# Auth: requires `wrangler login` first (browser OAuth). Wrangler
# stores creds in ~/.config/.wrangler/config — one-time per machine.

set -euo pipefail

BUCKET="tonel-downloads"
PUBLIC_BASE="https://download.tonel.io"

LOCAL="${1:-}"
REMOTE="${2:-}"

[ -n "$LOCAL" ] || { echo "usage: $0 <local-file> [remote-name]" >&2; exit 1; }
[ -f "$LOCAL" ] || { echo "[upload] no such file: $LOCAL" >&2; exit 1; }

# Default remote name to the local basename.
if [ -z "$REMOTE" ]; then
    REMOTE="$(basename "$LOCAL")"
fi

# Derive a "latest" alias from the remote name. Pattern:
#   Tonel-MacOS-v6.5.2.dmg     → Tonel-MacOS-latest.dmg
#   Tonel-Windows-v6.5.2.exe   → Tonel-Windows-latest.exe
# If the filename doesn't match we just skip the alias (keeps the
# script forgiving when uploading one-off files).
LATEST=""
if [[ "$REMOTE" =~ ^(Tonel-(MacOS|Windows))-v[0-9.]+\.(dmg|exe|msi|zip)$ ]]; then
    PREFIX="${BASH_REMATCH[1]}"
    EXT="${BASH_REMATCH[3]}"
    LATEST="${PREFIX}-latest.${EXT}"
fi

# wrangler is the official CF CLI. Install pointer:
#   npm i -g wrangler          (Node ≥ 18)
#   brew install cloudflare/cloudflare/wrangler
command -v wrangler >/dev/null 2>&1 \
    || { echo "[upload] wrangler not found — install with: npm i -g wrangler" >&2; exit 2; }

# Load CLOUDFLARE_API_TOKEN from deploy/.env.deploy if not already set.
# wrangler refuses to run non-interactively without it. The token also
# needs the "Workers R2 Storage: Edit" permission — see CHANGELOG v6.5.3
# for the dance to grant it on an existing token.
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    ENV_FILE="$(dirname "$0")/.env.deploy"
    if [ -f "$ENV_FILE" ]; then
        # shellcheck disable=SC2046
        export $(grep -E '^CLOUDFLARE_API_TOKEN=' "$ENV_FILE" | head -1 | xargs)
    fi
fi
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] \
    || { echo "[upload] CLOUDFLARE_API_TOKEN not set; check deploy/.env.deploy" >&2; exit 2; }

SIZE=$(stat -f %z "$LOCAL" 2>/dev/null || stat -c %s "$LOCAL")
SIZE_MB=$(awk "BEGIN{printf \"%.1f\", $SIZE/1048576}")
echo "[upload] $LOCAL (${SIZE_MB} MB) → r2://$BUCKET/$REMOTE"

# `--remote` hits the live R2 service (vs the local-emulator that
# wrangler v3+ uses by default for `r2 object` commands).
wrangler r2 object put "$BUCKET/$REMOTE" --file="$LOCAL" --remote

if [ -n "$LATEST" ]; then
    echo "[upload] also publishing alias → r2://$BUCKET/$LATEST"
    wrangler r2 object put "$BUCKET/$LATEST" --file="$LOCAL" --remote
fi

echo
echo "[upload] ✅ ready"
echo "[upload]   $PUBLIC_BASE/$REMOTE"
[ -n "$LATEST" ] && echo "[upload]   $PUBLIC_BASE/$LATEST"
