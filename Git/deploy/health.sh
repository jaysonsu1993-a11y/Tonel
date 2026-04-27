#!/bin/bash
# Post-deploy health check. Verifies expected processes are listening and
# WSS endpoints handshake.
#
# Usage: Git/deploy/health.sh [--dry-run]

source "$(dirname "$0")/lib/common.sh"

[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

load_env

FAIL=0

check_remote_port() {
    local proto="$1" port="$2" label="$3"
    if [ "$DRY_RUN" = "1" ]; then
        dim "  [dry-run] would check $label  $proto/$port"
        return
    fi
    if ssh -o ConnectTimeout=10 "$TONEL_SSH_HOST" "ss -${proto}lnp 2>/dev/null | awk '{print \$4}' | grep -qE ':$port\$'" >/dev/null 2>&1; then
        ok "  $label  $proto/$port  listening"
    else
        err "  $label  $proto/$port  NOT listening"
        FAIL=1
    fi
}

check_pm2_online() {
    local name="$1"
    if [ "$DRY_RUN" = "1" ]; then
        dim "  [dry-run] would check pm2  $name"
        return
    fi
    if ssh -o ConnectTimeout=10 "$TONEL_SSH_HOST" "pm2 jlist | grep -q '\"name\":\"$name\".*\"status\":\"online\"'" >/dev/null 2>&1; then
        ok "  pm2  $name  online"
    else
        err "  pm2  $name  NOT online"
        FAIL=1
    fi
}

check_wss_handshake() {
    local url="$1" label="$2"
    if [ "$DRY_RUN" = "1" ]; then
        dim "  [dry-run] would probe $label  $url"
        return
    fi
    # Use curl to perform a WS upgrade attempt; we only care that the server
    # responds with 101 Switching Protocols.
    local code
    code=$(curl -sk -o /dev/null -w '%{http_code}' \
        --max-time "${TONEL_HEALTH_TIMEOUT:-10}" \
        -H "Connection: Upgrade" \
        -H "Upgrade: websocket" \
        -H "Sec-WebSocket-Version: 13" \
        -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
        "$url" || echo "000")
    if [ "$code" = "101" ]; then
        ok "  wss  $label  101 Switching Protocols"
    else
        err "  wss  $label  HTTP $code (expected 101)"
        FAIL=1
    fi
}

log "─── port listeners ───"
check_remote_port t 9001 "signaling   "
check_remote_port t 9002 "mixer-tcp   "
check_remote_port u 9003 "mixer-udp   "
check_remote_port t 9004 "ws-proxy    "
check_remote_port t 9005 "ws-mixer-prx"
check_remote_port u 9006 "ws-mixer-udp"

log "─── pm2 processes ───"
check_pm2_online tonel-signaling
check_pm2_online tonel-mixer
check_pm2_online tonel-ws-proxy
check_pm2_online tonel-ws-mixer-proxy

log "─── public WSS endpoints ───"
check_wss_handshake "https://srv.tonel.io/mixer-tcp" "srv.tonel.io/mixer-tcp"
check_wss_handshake "https://srv.tonel.io/mixer-udp" "srv.tonel.io/mixer-udp"
check_wss_handshake "https://api.tonel.io/signaling" "api.tonel.io/signaling"

if [ "$FAIL" = "0" ]; then
    ok "all health checks passed"
    exit 0
else
    err "$FAIL check(s) failed — investigate before declaring deploy successful"
    exit 1
fi
