#!/bin/bash
# Deploy server-side artifacts to /opt/tonel/.
#
# Usage:
#   Git/deploy/server.sh [--component=binary|proxy|ops|all] [--dry-run]
#
# Components:
#   binary  — rsync server/ source → remote build → swap signaling_server + mixer_server
#   proxy   — rsync ws-proxy.js + ws-mixer-proxy.js + node_modules
#   ops     — rsync ops/ artifacts (PM2 ecosystem, nginx, cloudflared, scripts)
#   all     — binary + proxy + ops, in that order
#
# After all components: PM2 reload, nginx -t + reload, cloudflared restart if changed.
# Health check runs at the end (deploy/health.sh).

source "$(dirname "$0")/lib/common.sh"

# ─── Args ────────────────────────────────────────────────────────────────────

COMPONENT=all
for arg in "$@"; do
    case "$arg" in
        --component=*) COMPONENT="${arg#--component=}" ;;
        --dry-run)     DRY_RUN=1 ;;
        *) die "unknown arg: $arg" ;;
    esac
done

[[ "$COMPONENT" =~ ^(binary|proxy|ops|all)$ ]] || die "invalid --component=$COMPONENT"

load_env
require_clean_git

VERSION=$(get_version) || die "could not read version from CMakeLists.txt"
COMMIT=$(get_commit)

log "deploy target: $TONEL_SSH_HOST:$TONEL_DEPLOY_DIR"
log "version: v$VERSION  commit: $COMMIT  component: $COMPONENT  dry_run: $DRY_RUN"

# Sanity: deploy dir must exist (bootstrap.sh creates it for first-time setup).
if ! ssh_quiet "test -d '$TONEL_DEPLOY_DIR'"; then
    die "$TONEL_DEPLOY_DIR does not exist on remote — run deploy/bootstrap.sh first"
fi

# ─── binary ──────────────────────────────────────────────────────────────────

deploy_binary() {
    log "[binary] rsync server/ source"
    rsync_to_remote "$GIT_DIR/server/" "$TONEL_DEPLOY_DIR/build-src/"

    log "[binary] remote build (cmake)"
    ssh_exec "
        set -e
        cd '$TONEL_DEPLOY_DIR/build-src'
        cmake -S . -B build -DCMAKE_BUILD_TYPE=Release > /tmp/tonel-build.log 2>&1 || { tail -50 /tmp/tonel-build.log >&2; exit 1; }
        cmake --build build -j\$(nproc) >> /tmp/tonel-build.log 2>&1 || { tail -50 /tmp/tonel-build.log >&2; exit 1; }
        test -f build/signaling_server && test -f build/mixer_server
    "

    log "[binary] backup + swap into bin/"
    local stamp
    stamp=$(date +%Y%m%d-%H%M%S)
    ssh_exec "
        set -e
        mkdir -p '$TONEL_DEPLOY_DIR/bin'
        for f in signaling_server mixer_server; do
            if [ -f '$TONEL_DEPLOY_DIR/bin/\$f' ]; then
                cp '$TONEL_DEPLOY_DIR/bin/\$f' '$TONEL_DEPLOY_DIR/bin/\$f.bak.$stamp'
            fi
        done
    "

    # Stop, swap, start (one binary at a time to minimize downtime per process).
    for proc in signaling mixer; do
        local bin_name; [ "$proc" = "signaling" ] && bin_name=signaling_server || bin_name=mixer_server
        log "[binary] swap $bin_name (pm2 stop tonel-$proc)"
        ssh_exec "pm2 stop tonel-$proc 2>/dev/null || true"
        ssh_exec "cp '$TONEL_DEPLOY_DIR/build-src/build/$bin_name' '$TONEL_DEPLOY_DIR/bin/$bin_name'"
        ssh_exec "chmod +x '$TONEL_DEPLOY_DIR/bin/$bin_name'"
        ssh_exec "pm2 start tonel-$proc 2>/dev/null || pm2 startOrReload '$TONEL_DEPLOY_DIR/ops/ecosystem.config.cjs' --only tonel-$proc"
    done

    write_deploy_log binary "$VERSION" "$COMMIT"
    ok "[binary] done"
}

# ─── proxy ───────────────────────────────────────────────────────────────────

deploy_proxy() {
    log "[proxy] rsync proxy scripts"
    ssh_exec "mkdir -p '$TONEL_DEPLOY_DIR/proxy'"
    rsync_to_remote "$GIT_DIR/web/ws-proxy.js"       "$TONEL_DEPLOY_DIR/proxy/ws-proxy.js"
    rsync_to_remote "$GIT_DIR/web/ws-mixer-proxy.js" "$TONEL_DEPLOY_DIR/proxy/ws-mixer-proxy.js"

    log "[proxy] ensure node deps (ws)"
    ssh_exec "
        set -e
        cd '$TONEL_DEPLOY_DIR/proxy'
        if [ ! -f package.json ]; then
            cat > package.json <<EOF
{
  \"name\": \"tonel-proxy\",
  \"version\": \"1.0.0\",
  \"private\": true,
  \"dependencies\": { \"ws\": \"^8.18.0\" }
}
EOF
        fi
        npm install --omit=dev --no-fund --no-audit --silent
    "

    log "[proxy] pm2 reload (signaling+mixer proxies)"
    ssh_exec "pm2 reload tonel-ws-proxy tonel-ws-mixer-proxy 2>/dev/null || pm2 startOrReload '$TONEL_DEPLOY_DIR/ops/ecosystem.config.cjs' --only tonel-ws-proxy,tonel-ws-mixer-proxy"

    write_deploy_log proxy "$VERSION" "$COMMIT"
    ok "[proxy] done"
}

# ─── ops ─────────────────────────────────────────────────────────────────────

deploy_ops() {
    log "[ops] rsync PM2 ecosystem + start scripts"
    ssh_exec "mkdir -p '$TONEL_DEPLOY_DIR/ops' '$TONEL_DEPLOY_DIR/scripts'"
    rsync_to_remote "$GIT_DIR/ops/pm2/ecosystem.config.cjs" "$TONEL_DEPLOY_DIR/ops/ecosystem.config.cjs"
    rsync_to_remote "$GIT_DIR/ops/scripts/"                  "$TONEL_DEPLOY_DIR/scripts/"
    ssh_exec "chmod +x '$TONEL_DEPLOY_DIR/scripts/'*.sh"

    log "[ops] apply nginx site configs"
    rsync_to_remote "$GIT_DIR/ops/nginx/srv.tonel.io.conf" "/etc/nginx/sites-available/srv.tonel.io"
    rsync_to_remote "$GIT_DIR/ops/nginx/tonel.io.conf"     "/etc/nginx/sites-available/tonel.io"
    ssh_exec "
        set -e
        ln -sf /etc/nginx/sites-available/srv.tonel.io /etc/nginx/sites-enabled/srv.tonel.io
        ln -sf /etc/nginx/sites-available/tonel.io     /etc/nginx/sites-enabled/tonel.io
        nginx -t
        systemctl reload nginx
    "

    log "[ops] apply cloudflared config"
    [ -n "${TONEL_CF_TUNNEL_ID:-}" ] || die "TONEL_CF_TUNNEL_ID not set in .env.deploy"
    local tmp; tmp=$(mktemp)
    # Substitute ${TUNNEL_ID} only on non-comment lines (preserves docs/examples).
    awk -v id="$TONEL_CF_TUNNEL_ID" '
        /^[[:space:]]*#/ { print; next }
        { gsub(/\$\{TUNNEL_ID\}/, id); print }
    ' "$GIT_DIR/ops/cloudflared/config.yml.template" > "$tmp"
    rsync_to_remote "$tmp" "/root/.cloudflared/config.yml"
    rm -f "$tmp"
    ssh_exec "systemctl restart cloudflared"

    log "[ops] save PM2 process list (so it survives reboot)"
    ssh_exec "pm2 save"

    write_deploy_log ops "$VERSION" "$COMMIT"
    ok "[ops] done"
}

# ─── Run selected components ─────────────────────────────────────────────────

case "$COMPONENT" in
    binary) deploy_binary ;;
    proxy)  deploy_proxy ;;
    ops)    deploy_ops ;;
    all)
        deploy_ops      # ops first so PM2 ecosystem matches expectations before swaps
        deploy_proxy
        deploy_binary
        ;;
esac

log "running health check"
"$DEPLOY_DIR/health.sh" $(dry_run_flag)
