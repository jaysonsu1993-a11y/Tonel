#!/bin/bash
# One-time migration from /opt/tonel-server/ (legacy) to /opt/tonel/ (v1.0.3+).
#
# Idempotent: safe to re-run. Does the following on the production server:
#   1. Snapshots /opt/tonel-server/ to $TONEL_ARCHIVE_DIR (one-time only)
#   2. Creates /opt/tonel/, /var/lib/tonel/, /var/log/tonel/
#   3. Migrates current binaries + proxies from legacy paths
#   4. Removes the dead `tonel-webrtc-mixer` PM2 process and webrtc-mixer-proxy.js
#   5. Stops legacy PM2 processes and restarts via the new ecosystem.config.cjs
#   6. Saves the PM2 process list (for reboot persistence)
#
# DOES NOT delete /opt/tonel-server/ — that stays as a fallback for at least one
# week. Manual cleanup later via `deploy/bootstrap.sh --finalize` (TODO).
#
# Usage:
#   deploy/bootstrap.sh [--dry-run]
#
# Run AFTER you have at least one good v1.0.3 build on disk. The script will
# call `deploy/server.sh --component=all` once paths are ready.

source "$(dirname "$0")/lib/common.sh"

[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

load_env
require_clean_git

VERSION=$(get_version)
COMMIT=$(get_commit)

log "bootstrap migration → /opt/tonel/  (v$VERSION, $COMMIT)"
log "legacy install: /opt/tonel-server/  (will be archived, NOT deleted)"
warn "this stops all tonel-* PM2 processes briefly. Confirm only during a maintenance window."
confirm "proceed with bootstrap?"

# ─── 1. Snapshot legacy ──────────────────────────────────────────────────────

log "[1/6] snapshotting /opt/tonel-server/ → $TONEL_ARCHIVE_DIR/"
ssh_exec "
    set -e
    mkdir -p '$TONEL_ARCHIVE_DIR'
    if [ ! -d '$TONEL_ARCHIVE_DIR/tonel-server-pre-bootstrap' ]; then
        cp -a /opt/tonel-server '$TONEL_ARCHIVE_DIR/tonel-server-pre-bootstrap'
        echo 'snapshot created'
    else
        echo 'snapshot already exists, skipping'
    fi
"

# ─── 2. Create new layout ────────────────────────────────────────────────────

log "[2/6] creating /opt/tonel/, /var/lib/tonel/, /var/log/tonel/"
ssh_exec "
    set -e
    mkdir -p '$TONEL_DEPLOY_DIR'/{bin,proxy,scripts,ops}
    mkdir -p '$TONEL_RUNTIME_DIR/recordings'
    mkdir -p '$TONEL_LOG_DIR'
    chmod 755 '$TONEL_DEPLOY_DIR' '$TONEL_RUNTIME_DIR' '$TONEL_LOG_DIR'
"

# ─── 3. Migrate current binaries + proxies ───────────────────────────────────

log "[3/6] migrating existing binaries + proxies (so we don't downgrade)"
ssh_exec "
    set -e
    DST=$TONEL_DEPLOY_DIR
    # Remove leftover '\$name'-literal files from a buggy earlier bootstrap (idempotent).
    rm -f \"\$DST/bin/\\\$name\" \"\$DST/proxy/\\\$name\" 2>/dev/null || true
    # binaries: prefer /opt/tonel-server/bin/ (newer scheme); fall back to root.
    for name in signaling_server mixer_server; do
        if [ -f /opt/tonel-server/bin/\$name ]; then
            cp /opt/tonel-server/bin/\$name \"\$DST/bin/\$name\"
        elif [ -f /opt/tonel-server/\$name ]; then
            cp /opt/tonel-server/\$name \"\$DST/bin/\$name\"
        fi
        chmod +x \"\$DST/bin/\$name\" 2>/dev/null || true
    done
    # proxies
    for name in ws-proxy.js ws-mixer-proxy.js; do
        if [ -f /opt/tonel-server/\$name ]; then
            cp /opt/tonel-server/\$name \"\$DST/proxy/\$name\"
        fi
    done
    # node_modules — copy if exists (saves npm install)
    if [ -d /opt/tonel-server/node_modules ] && [ ! -d \"\$DST/proxy/node_modules\" ]; then
        cp -a /opt/tonel-server/node_modules \"\$DST/proxy/node_modules\" 2>/dev/null || true
    fi
    if [ -f /opt/tonel-server/package.json ]; then
        cp /opt/tonel-server/package.json \"\$DST/proxy/package.json\"
    fi
"

# ─── 4. Remove dead webrtc proxy ─────────────────────────────────────────────

log "[4/6] retiring tonel-webrtc-mixer (was kept around but no longer in architecture)"
ssh_exec "
    pm2 delete tonel-webrtc-mixer 2>/dev/null || true
    pm2 save 2>/dev/null || true
"

# ─── 5. Stop legacy PM2, install new ecosystem, start ────────────────────────

log "[5/6] stopping legacy PM2 processes + starting via new ecosystem"
ssh_exec "
    set -e
    pm2 delete tonel-signaling tonel-mixer tonel-ws-proxy tonel-ws-mixer-proxy 2>/dev/null || true
"

# Push ops + scripts now (server.sh ops also does this, but we need them in place
# before pm2 start can find them).
log "[5/6] pushing ops/ecosystem.config.cjs + scripts/"
rsync_to_remote "$REPO_ROOT/ops/pm2/ecosystem.config.cjs" "$TONEL_DEPLOY_DIR/ops/ecosystem.config.cjs"
rsync_to_remote "$REPO_ROOT/ops/scripts/"                  "$TONEL_DEPLOY_DIR/scripts/"
ssh_exec "chmod +x '$TONEL_DEPLOY_DIR/scripts/'*.sh"

ssh_exec "
    set -e
    pm2 start '$TONEL_DEPLOY_DIR/ops/ecosystem.config.cjs'
    pm2 save
"

# ─── 6. Apply nginx + cloudflared (via server.sh ops) ────────────────────────

log "[6/6] applying nginx + cloudflared from ops/ via server.sh"
"$DEPLOY_DIR/server.sh" --component=ops $(dry_run_flag)

# ─── Summary ─────────────────────────────────────────────────────────────────

ssh_exec "echo 'v$VERSION' > '$TONEL_DEPLOY_DIR/VERSION'"
write_deploy_log bootstrap "$VERSION" "$COMMIT"

log "running health check"
"$DEPLOY_DIR/health.sh" $(dry_run_flag)

ok "bootstrap complete. /opt/tonel-server/ preserved at $TONEL_ARCHIVE_DIR/tonel-server-pre-bootstrap/"
log "after a week of stable operation, you can manually rm -rf /opt/tonel-server/"
