#!/bin/bash
# Tonel release orchestrator. The canonical "ship a new version" entry point.
#
# Pipeline:
#   1. bump-version.sh <version>         (sync version across CMakeLists / package.json / config.schema)
#   2. pause for CHANGELOG editing       (hard-fail if user forgets)
#   3. git commit + tag + push           (after explicit confirmation)
#   4. Git/deploy/server.sh              (rsync + remote build + pm2 reload + nginx reload)
#   5. Git/deploy/web.sh                 (vite build + wrangler pages deploy)
#   6. Git/deploy/health.sh              (verify everything is live)
#
# Usage:
#   Git/scripts/release.sh <version>                  # full pipeline
#   Git/scripts/release.sh <version> --skip-deploy    # bump+commit+tag+push only
#   Git/scripts/release.sh <version> --skip-push      # local-only (no remote push, no deploy)
#   Git/scripts/release.sh deploy-only                # redeploy current HEAD without bumping
#
# All deploy steps prompt before destructive actions. Set YES=1 to skip prompts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$GIT_DIR/deploy"
REPO_ROOT="$(cd "$GIT_DIR/.." && pwd)"

# ─── Logging (mirrors deploy/lib/common.sh) ──────────────────────────────────

if [ -t 1 ]; then
    C_BLD=$'\033[1m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
    C_BLD=; C_GRN=; C_YEL=; C_RED=; C_DIM=; C_RST=
fi
log()  { printf '%s[release]%s %s\n' "$C_BLD" "$C_RST" "$*"; }
ok()   { printf '%s[release]%s %s%s%s\n' "$C_BLD" "$C_RST" "$C_GRN" "$*" "$C_RST"; }
warn() { printf '%s[release]%s %s%s%s\n' "$C_BLD" "$C_RST" "$C_YEL" "$*" "$C_RST" >&2; }
die()  { printf '%s[release]%s %sERROR:%s %s\n' "$C_BLD" "$C_RST" "$C_RED" "$C_RST" "$*" >&2; exit 1; }

confirm() {
    [ "${YES:-0}" = "1" ] && return 0
    read -rp "$* [y/N] " ans
    [[ "$ans" =~ ^[yY]$ ]] || die "aborted"
}

# ─── Args ────────────────────────────────────────────────────────────────────

[ $# -ge 1 ] || die "usage: $0 <version> [--skip-deploy|--skip-push] | deploy-only"

MODE=full
NEW_VERSION=""
case "$1" in
    deploy-only) MODE=deploy-only ;;
    *)
        NEW_VERSION="$1"
        [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be MAJOR.MINOR.PATCH"
        shift
        for arg in "$@"; do
            case "$arg" in
                --skip-deploy) MODE=skip-deploy ;;
                --skip-push)   MODE=skip-push ;;
                *) die "unknown arg: $arg" ;;
            esac
        done
        ;;
esac

cd "$REPO_ROOT"

# ─── Pre-flight ──────────────────────────────────────────────────────────────

if [ "$MODE" != "deploy-only" ]; then
    [ -n "$(git status --porcelain)" ] && { git status --short; die "working tree dirty — commit or stash first"; }
    [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "must be on main branch"
fi

# ─── Step 1+2+3: bump + CHANGELOG + commit + tag + push ─────────────────────

if [ "$MODE" != "deploy-only" ]; then
    log "═══ release v$NEW_VERSION ═══"
    cd "$GIT_DIR"

    log "[1/6] bump-version.sh $NEW_VERSION"
    YES=1 ./scripts/bump-version.sh "$NEW_VERSION"   # bump-version.sh has its own prompt; YES=1 skips it

    log "[2/6] verify CHANGELOG.md has [$NEW_VERSION] entry"
    if ! grep -qE "^## \[$NEW_VERSION\]" CHANGELOG.md; then
        warn "CHANGELOG.md is missing entry for v$NEW_VERSION"
        warn "open CHANGELOG.md, add a [$NEW_VERSION] section in Keep-a-Changelog format,"
        warn "then re-run with the same version."
        die "CHANGELOG required"
    fi

    cd "$REPO_ROOT"
    log "[3/6] commit + tag"
    git add -A
    git commit -m "release: v$NEW_VERSION"
    git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"

    if [ "$MODE" = "skip-push" ]; then
        warn "skipping git push (per --skip-push)"
    else
        confirm "git push origin main --tags  ?"
        git push origin main --tags
        ok "[3/6] pushed v$NEW_VERSION"
    fi

    if [ "$MODE" = "skip-deploy" ] || [ "$MODE" = "skip-push" ]; then
        ok "release v$NEW_VERSION recorded (no deploy)"
        exit 0
    fi
fi

# ─── Step 4+5+6: deploy server, web, verify ─────────────────────────────────

log "[4/6] deploying server (binary + proxy + ops)"
"$DEPLOY_DIR/server.sh"

log "[5/6] deploying web frontend"
"$DEPLOY_DIR/web.sh"

log "[6/6] health check"
"$DEPLOY_DIR/health.sh"

VERSION_NOW=$(sed -nE 's/^project\(Tonel VERSION ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' "$GIT_DIR/CMakeLists.txt" | head -1)
COMMIT_NOW=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
ok "═══ v$VERSION_NOW ($COMMIT_NOW) live ═══"
