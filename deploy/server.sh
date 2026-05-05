#!/bin/bash
# Deploy server-side artifacts to /opt/tonel/.
#
# Usage:
#   deploy/server.sh [--component=binary|proxy|wt-proxy|ops|all] [--dry-run]
#
# Components:
#   binary    — cross-compile mixer + signaling locally (Docker, debian:12) → rsync ELF → swap
#   proxy     — rsync ws-proxy.js + ws-mixer-proxy.js + node_modules
#   wt-proxy  — cross-compile Go WebTransport proxy locally → rsync binary → pm2 reload
#   ops       — rsync ops/ artifacts (PM2 ecosystem, nginx, cloudflared, scripts)
#   all       — ops + proxy + wt-proxy + binary, in that order
#
# After all components: PM2 reload, nginx -t + reload, cloudflared restart if changed.
# Health check runs at the end (deploy/health.sh).
#
# Build hosts:
#   - binary (C++): Docker Desktop (or compatible) running on the operator's
#     machine. The container (debian:12, see server/.docker/Dockerfile)
#     matches prod's glibc/ABI; production needs no toolchain.
#   - wt-proxy (Go): operator's Go SDK (`brew install go`). CGO_ENABLED=0 so
#     the binary is fully static.

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

[[ "$COMPONENT" =~ ^(binary|proxy|wt-proxy|ops|all)$ ]] || die "invalid --component=$COMPONENT"

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
    # Cross-compile locally inside debian:12 container, ship ELF only.
    # Replaces the legacy "rsync source + remote cmake" approach (v5.1.0
    # incident: prod had no cmake installed; on a fresh box `apt install`
    # would have been required just to deploy a no-op release). Building
    # locally also makes the binary deterministic w.r.t. the dev machine's
    # toolchain version, not whatever apt happens to ship today.
    local img="tonel-server-builder:debian12"
    local builder_dir="$REPO_ROOT/server/.docker"
    local out_dir="$REPO_ROOT/server/build-linux"

    log "[binary] verify Docker"
    command -v docker >/dev/null 2>&1 || die "docker not found locally — install Docker Desktop"
    docker info >/dev/null 2>&1 || die "docker daemon not running — start Docker Desktop and retry"

    if ! docker image inspect "$img" >/dev/null 2>&1; then
        log "[binary] building cross-compile image (one-time, ~2 min)"
        run "docker buildx build --platform linux/amd64 -t '$img' '$builder_dir'" \
            || die "docker build failed"
    fi

    log "[binary] cross-compile inside container (linux/amd64)"
    rm -rf "$out_dir"
    mkdir -p "$out_dir"
    # Source mounted ro; copy into the container's writable /tmp/srcwork before
    # running cmake so build artifacts don't leak back into the host tree.
    # /out is the only writable mount; we drop just signaling_server and
    # mixer_server there.
    run "docker run --rm --platform linux/amd64 \
        -v '$REPO_ROOT/server:/src:ro' \
        -v '$out_dir:/out' \
        '$img' \
        bash -c '
            set -e
            # Copy source into the container so build/ artifacts do not leak
            # back through the read-only mount. Skip the host-side build/ and
            # .cache/ — they hold a CMakeCache pinned to the macOS source
            # path and would poison the in-container cmake run.
            mkdir -p /tmp/srcwork
            (cd /src && tar --exclude=build --exclude=.cache --exclude=node_modules -cf - .) \
                | tar -xf - -C /tmp/srcwork
            cd /tmp/srcwork
            cmake -S . -B build -DCMAKE_BUILD_TYPE=Release > /tmp/build.log 2>&1 || { tail -50 /tmp/build.log >&2; exit 1; }
            cmake --build build -j\$(nproc) >> /tmp/build.log 2>&1 || { tail -50 /tmp/build.log >&2; exit 1; }
            cp build/signaling_server build/mixer_server /out/
        '" || die "cross-compile failed"

    file "$out_dir/signaling_server" | grep -q 'ELF 64-bit LSB.*x86-64' \
        || die "signaling_server is not a Linux x86-64 ELF — check Dockerfile platform"
    file "$out_dir/mixer_server" | grep -q 'ELF 64-bit LSB.*x86-64' \
        || die "mixer_server is not a Linux x86-64 ELF — check Dockerfile platform"
    ok "[binary] cross-compile done — $(ls -la "$out_dir"/{signaling,mixer}_server | awk '{print $9":"$5}' | xargs)"

    log "[binary] backup current bin/ on remote"
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

    # Stop, rsync ELF, start (one process at a time to minimize downtime).
    for proc in signaling mixer; do
        local bin_name; [ "$proc" = "signaling" ] && bin_name=signaling_server || bin_name=mixer_server
        log "[binary] swap $bin_name (pm2 stop tonel-$proc)"
        ssh_exec "pm2 stop tonel-$proc 2>/dev/null || true"
        rsync_to_remote "$out_dir/$bin_name" "$TONEL_DEPLOY_DIR/bin/$bin_name"
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
    rsync_to_remote "$REPO_ROOT/web/ws-proxy.js"       "$TONEL_DEPLOY_DIR/proxy/ws-proxy.js"
    rsync_to_remote "$REPO_ROOT/web/ws-mixer-proxy.js" "$TONEL_DEPLOY_DIR/proxy/ws-mixer-proxy.js"

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

# ─── wt-proxy ────────────────────────────────────────────────────────────────

deploy_wt_proxy() {
    local src="$REPO_ROOT/server/wt-mixer-proxy"
    [ -d "$src" ] || die "wt-proxy source missing at $src"

    log "[wt-proxy] cross-compile Go binary (linux/amd64)"
    command -v go >/dev/null 2>&1 || die "go not found locally — install with 'brew install go' (or apt) and rerun"

    local out="$src/build/wt-mixer-proxy"
    mkdir -p "$src/build"
    (
        cd "$src"
        # CGO off so the binary is fully static — drops without
        # libc-version concerns on the production host.
        CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$out" ./...
    ) || die "go build failed"
    file "$out" | grep -q 'ELF 64-bit LSB' || die "wt-mixer-proxy build is not Linux ELF"

    log "[wt-proxy] rsync binary to remote bin/"
    ssh_exec "mkdir -p '$TONEL_DEPLOY_DIR/bin'"
    rsync_to_remote "$out" "$TONEL_DEPLOY_DIR/bin/wt-mixer-proxy"
    ssh_exec "chmod +x '$TONEL_DEPLOY_DIR/bin/wt-mixer-proxy'"

    log "[wt-proxy] pm2 reload tonel-wt-mixer-proxy"
    ssh_exec "
        pm2 reload tonel-wt-mixer-proxy 2>/dev/null \
        || pm2 startOrReload '$TONEL_DEPLOY_DIR/ops/ecosystem.config.cjs' --only tonel-wt-mixer-proxy
    "

    write_deploy_log wt-proxy "$VERSION" "$COMMIT"
    ok "[wt-proxy] done"
}

# ─── ops ─────────────────────────────────────────────────────────────────────

deploy_ops() {
    log "[ops] rsync PM2 ecosystem + start scripts"
    ssh_exec "mkdir -p '$TONEL_DEPLOY_DIR/ops' '$TONEL_DEPLOY_DIR/scripts'"
    rsync_to_remote "$REPO_ROOT/ops/pm2/ecosystem.config.cjs" "$TONEL_DEPLOY_DIR/ops/ecosystem.config.cjs"
    rsync_to_remote "$REPO_ROOT/ops/scripts/"                  "$TONEL_DEPLOY_DIR/scripts/"
    ssh_exec "chmod +x '$TONEL_DEPLOY_DIR/scripts/'*.sh"

    log "[ops] apply nginx site configs"
    rsync_to_remote "$REPO_ROOT/ops/nginx/srv.tonel.io.conf"     "/etc/nginx/sites-available/srv.tonel.io"
    rsync_to_remote "$REPO_ROOT/ops/nginx/srv-new.tonel.io.conf" "/etc/nginx/sites-available/srv-new.tonel.io"
    rsync_to_remote "$REPO_ROOT/ops/nginx/tonel.io.conf"         "/etc/nginx/sites-available/tonel.io"
    # srv-hk.tonel.io is HK-staging only (v5.1.22+); shipped if the conf exists.
    if [ -f "$REPO_ROOT/ops/nginx/srv-hk.tonel.io.conf" ]; then
        rsync_to_remote "$REPO_ROOT/ops/nginx/srv-hk.tonel.io.conf" "/etc/nginx/sites-available/srv-hk.tonel.io"
    fi
    # api-hk.tonel.io is HK signaling (v5.1.25+, no CF Tunnel); same conditional.
    if [ -f "$REPO_ROOT/ops/nginx/api-hk.tonel.io.conf" ]; then
        rsync_to_remote "$REPO_ROOT/ops/nginx/api-hk.tonel.io.conf" "/etc/nginx/sites-available/api-hk.tonel.io"
    fi
    # Self-healing symlinks (v5.1.23+): only enable a site whose
    # ssl_certificate path exists on this box. The four nginx configs
    # cover all server roles (kufan, Aliyun, HK, CF Pages origin); each
    # box only has certs for the subset it actually serves. Symlinking
    # all four blindly causes `nginx -t` to fail and the deploy aborts.
    ssh_exec '
        set -e
        for conf in srv.tonel.io srv-new.tonel.io tonel.io srv-hk.tonel.io api-hk.tonel.io; do
            avail=/etc/nginx/sites-available/$conf
            link=/etc/nginx/sites-enabled/$conf
            [ -f "$avail" ] || continue
            cert=$(awk "/^[[:space:]]*ssl_certificate[[:space:]]/ { gsub(/;/,\"\"); print \$2; exit }" "$avail")
            if [ -z "$cert" ] || [ -f "$cert" ]; then
                ln -sf "$avail" "$link"
            else
                echo "[ops] skipping $conf — cert $cert not present on this box"
                rm -f "$link"
            fi
        done
        if nginx -t 2>&1; then
            systemctl reload nginx
        else
            echo "[ops] WARN: nginx -t failed; not reloading"
        fi
    '

    if [ -n "${TONEL_CF_TUNNEL_ID:-}" ]; then
        log "[ops] apply cloudflared config (TONEL_CF_TUNNEL_ID=$TONEL_CF_TUNNEL_ID)"
        local tmp; tmp=$(mktemp)
        # Substitute ${TUNNEL_ID} only on non-comment lines (preserves docs/examples).
        awk -v id="$TONEL_CF_TUNNEL_ID" '
            /^[[:space:]]*#/ { print; next }
            { gsub(/\$\{TUNNEL_ID\}/, id); print }
        ' "$REPO_ROOT/ops/cloudflared/config.yml.template" > "$tmp"
        rsync_to_remote "$tmp" "/root/.cloudflared/config.yml"
        rm -f "$tmp"

        # Install systemd drop-in extending Start/StopSec to 180s. cloudflared's
        # upstream unit ships with TimeoutStartSec=15 (way too short for re-
        # establishing 4 edge connections); the v5.1.0 release deploy hit this
        # and aborted with a timeout. Drop-in survives `cloudflared service
        # install` upgrades, unlike editing the unit file. Path is fixed at
        # /etc/systemd/system/cloudflared.service.d/ per systemd conventions.
        log "[ops] install cloudflared.service.d/ drop-in (TimeoutStart/Stop=180)"
        ssh_exec "mkdir -p /etc/systemd/system/cloudflared.service.d"
        rsync_to_remote "$REPO_ROOT/ops/cloudflared/cloudflared.service.d/timeout.conf" \
            "/etc/systemd/system/cloudflared.service.d/timeout.conf"
        ssh_exec "systemctl daemon-reload"

        ssh_exec "systemctl restart cloudflared"
    else
        log "[ops] TONEL_CF_TUNNEL_ID empty — skipping cloudflared config (HK direct-IP target)"
    fi

    log "[ops] save PM2 process list (so it survives reboot)"
    ssh_exec "pm2 save"

    write_deploy_log ops "$VERSION" "$COMMIT"
    ok "[ops] done"
}

# ─── Run selected components ─────────────────────────────────────────────────

case "$COMPONENT" in
    binary)   deploy_binary   ;;
    proxy)    deploy_proxy    ;;
    wt-proxy) deploy_wt_proxy ;;
    ops)      deploy_ops      ;;
    all)
        deploy_ops      # ops first so PM2 ecosystem matches expectations before swaps
        deploy_proxy    # WSS proxies — fallback path; deployed first so the WT
                        # rollout can't strand users on a stale ecosystem
        deploy_wt_proxy # WT proxy — new in v4.0.0; failures here are non-fatal
                        # because the web client falls back to WSS automatically
        deploy_binary
        ;;
esac

log "running health check"
"$DEPLOY_DIR/health.sh" $(dry_run_flag)
