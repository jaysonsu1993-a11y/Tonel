#!/bin/bash
# Tonel release orchestrator. The canonical "ship a new version" entry point.
#
# Pipeline:
#   1. bump-version.sh <version>         (sync version across CMakeLists / package.json / config.schema)
#   2. pause for CHANGELOG editing       (hard-fail if user forgets)
#   3. git commit + tag + push           (after explicit confirmation)
#                                        Pushing the tag triggers the
#                                        Windows CI (.github/workflows/
#                                        build-installer.yml) which builds
#                                        + publishes the .exe to GH Release
#                                        + R2 in parallel — we don't block.
#   4. deploy/package-macos.sh           (build .dmg locally — CI doesn't
#      + deploy/upload-r2.sh             do macOS, free runner is Linux/Win)
#   5. deploy/server.sh × 2              (deploy to BOTH 广州1 Aliyun and
#                                        广州2 Kufan; v6.5.3 brought Kufan
#                                        back online so production is dual-
#                                        server now)
#   6. deploy/web.sh                     (vite build + wrangler pages deploy)
#   7. URL verify                        (curl R2 + tonel.io)
#
# Usage:
#   scripts/release.sh <version>                  # full pipeline
#   scripts/release.sh <version> --skip-deploy    # bump+commit+tag+push only
#   scripts/release.sh <version> --skip-push      # local-only (no remote push, no deploy)
#   scripts/release.sh deploy-only                # redeploy current HEAD without bumping
#
# All deploy steps prompt before destructive actions. Set YES=1 to skip prompts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy"

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
#
# Intentionally NOT requiring a clean working tree here. The release commit
# is supposed to collect (a) the version bumps from bump-version.sh, (b) the
# new CHANGELOG section the operator wrote, and (c) any feature changes
# that motivated this release — all into one atomic commit. Refusing to run
# on a dirty tree would force a separate "feature changes" commit on main,
# which violates the project's "no bare commits to main" rule (every main
# commit must go through bump → CHANGELOG → tag → push).

if [ "$MODE" != "deploy-only" ]; then
    [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "must be on main branch"
fi

# ─── Step 0: pre-release safety gate ────────────────────────────────────────
#
# Server unit tests + Layer 1/1.5 audio + signaling integration + Layer 2
# browser audio. Catches the regression class that the user kept hitting in
# production (e.g. the v3.6.x peers=0 reconnect bug). Fails fast — if any
# layer breaks, we don't bump, commit, push, or deploy. Set SKIP_PRETEST=1
# to bypass for an emergency hotfix (NOT recommended).
if [ "${SKIP_PRETEST:-0}" = "1" ]; then
    warn "[0/8] SKIP_PRETEST=1 — skipping pre-release smoke (NOT RECOMMENDED)"
else
    log "[0/8] pre-release smoke (scripts/pretest.sh)"
    "$SCRIPT_DIR/pretest.sh" || die "pretest failed — refusing to release. Fix and re-run."
    ok "[0/8] pretest passed"
fi

# ─── Step 1+2+3: bump + CHANGELOG + commit + tag + push ─────────────────────

if [ "$MODE" != "deploy-only" ]; then
    log "═══ release v$NEW_VERSION ═══"
    cd "$REPO_ROOT"

    log "[1/8] bump-version.sh $NEW_VERSION"
    YES=1 ./scripts/bump-version.sh "$NEW_VERSION"   # bump-version.sh has its own prompt; YES=1 skips it

    log "[2/8] verify CHANGELOG.md has [$NEW_VERSION] entry"
    if ! grep -qE "^## \[$NEW_VERSION\]" CHANGELOG.md; then
        warn "CHANGELOG.md is missing entry for v$NEW_VERSION"
        warn "open CHANGELOG.md, add a [$NEW_VERSION] section in Keep-a-Changelog format,"
        warn "then re-run with the same version."
        die "CHANGELOG required"
    fi

    cd "$REPO_ROOT"
    log "[3/8] commit + tag"
    git add -A
    git commit -m "release: v$NEW_VERSION"
    git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"

    if [ "$MODE" = "skip-push" ]; then
        warn "skipping git push (per --skip-push)"
    else
        confirm "git push origin main --tags  ?"
        git push origin main --tags
        ok "[3/8] pushed v$NEW_VERSION (Windows CI starting in parallel)"
    fi

    if [ "$MODE" = "skip-deploy" ] || [ "$MODE" = "skip-push" ]; then
        ok "release v$NEW_VERSION recorded (no deploy)"
        exit 0
    fi
fi

# ─── Step 4: macOS .dmg (build + R2 push) ────────────────────────────────────
#
# CI doesn't build macOS — `windows-latest` runner can't xcodebuild and
# `macos-latest` runner is 10× the cost of windows. Cheaper to do this
# locally as part of the release flow. ~2 min on Apple Silicon.

log "[4/8] macOS .dmg → R2"
"$DEPLOY_DIR/package-macos.sh"
VERSION_NOW=$(sed -nE 's/^project\(Tonel VERSION ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' "$REPO_ROOT/CMakeLists.txt" | head -1)
DMG="$DEPLOY_DIR/dist/Tonel-MacOS-v$VERSION_NOW.dmg"
[ -f "$DMG" ] || die "package-macos.sh did not produce $DMG"
"$DEPLOY_DIR/upload-r2.sh" "$DMG"

# ─── Step 5: server deploy (Aliyun + Kufan) ─────────────────────────────────
#
# Dual-server since v6.5.3 (Kufan IDC ban lifted, brought back online).
# Both run feature-parity v6.x binaries; clients pick which via the
# Settings 服务器 picker (广州1 / 广州2). Server-first ordering matches
# `feedback_versioning` for protocol-breaking releases.

log "[5/8] server → 广州1 Aliyun (8.163.21.207)"
TONEL_SSH_HOST=root@8.163.21.207 TONEL_SSH_PORT=22 \
    "$DEPLOY_DIR/server.sh" --component=binary

log "[6/8] server → 广州2 Kufan (42.240.163.172)"
TONEL_SSH_HOST=root@42.240.163.172 TONEL_SSH_PORT=26806 \
    "$DEPLOY_DIR/server.sh" --component=binary

# ─── Step 7: web ─────────────────────────────────────────────────────────────

log "[7/8] web → Cloudflare Pages (tonel-web)"
"$DEPLOY_DIR/web.sh"

# ─── Step 8: verify public URLs ──────────────────────────────────────────────

log "[8/8] verify public URLs"
verify() {
    local url="$1"
    local code
    code=$(curl -sIL -o /dev/null -w "%{http_code}" --max-time 10 "$url" || echo "000")
    if [ "$code" = "200" ]; then
        printf '%s[release]%s   %s%s%s → HTTP %s ✅\n' "$C_BLD" "$C_RST" "$C_GRN" "$url" "$C_RST" "$code"
    else
        printf '%s[release]%s   %s%s%s → HTTP %s ❌\n' "$C_BLD" "$C_RST" "$C_RED" "$url" "$C_RST" "$code"
        return 1
    fi
}
verify https://download.tonel.io/Tonel-MacOS-latest.dmg
# Windows .exe might lag a few minutes behind — Windows CI is async.
# Don't fail the release on it; just print status.
verify https://download.tonel.io/Tonel-Windows-latest.exe || \
    warn "Windows-latest.exe not yet updated — Windows CI is still running. Track via:"
warn "  https://github.com/jaysonsu1993-a11y/Tonel/actions"
verify https://tonel.io/

COMMIT_NOW=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
ok "═══ v$VERSION_NOW ($COMMIT_NOW) live ═══"
log
log "summary:"
log "  • macOS  Tonel-MacOS-v$VERSION_NOW.dmg → R2 ✅"
log "  • server v$VERSION_NOW → Aliyun + Kufan ✅"
log "  • web    v$VERSION_NOW → CF Pages ✅"
log "  • Windows CI building Tonel-Windows-v$VERSION_NOW.exe (async, ~3 min)"
