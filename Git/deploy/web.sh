#!/bin/bash
# Build and deploy the web frontend to Cloudflare Pages.
#
# Usage: Git/deploy/web.sh [--dry-run]
#
# Reads CLOUDFLARE_API_TOKEN and TONEL_CF_PAGES_PROJECT from .env.deploy.

source "$(dirname "$0")/lib/common.sh"

[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

load_env
require_clean_git
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN not set in .env.deploy}"
: "${TONEL_CF_PAGES_PROJECT:?TONEL_CF_PAGES_PROJECT not set in .env.deploy}"

VERSION=$(get_version) || die "could not read version"
COMMIT=$(get_commit)

log "deploying web v$VERSION ($COMMIT) → Cloudflare Pages project '$TONEL_CF_PAGES_PROJECT'"

cd "$GIT_DIR/web"

# 1. Install + build (vite produces dist/)
log "installing deps + building"
run "npm install --silent --no-fund --no-audit"
run "npm run build"

# 2. Wrangler publish
log "publishing dist/ via wrangler"
run "CLOUDFLARE_API_TOKEN='$CLOUDFLARE_API_TOKEN' npx --yes wrangler@4 pages deploy dist \
    --project-name='$TONEL_CF_PAGES_PROJECT' \
    --commit-hash='$COMMIT' \
    --commit-message='release: v$VERSION'"

ok "web deploy complete (v$VERSION, $COMMIT)"
