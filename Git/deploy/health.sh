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
    # Probe a WSS endpoint *from the production server* (not the operator's laptop).
    # Local WSS probes are unreliable: the operator's ISP path may apply SNI-based
    # filtering on direct-to-origin TLS (esp. for non-CF endpoints like srv.tonel.io),
    # producing false negatives that have nothing to do with deploy health.
    #
    # Mode "strict" (default): expect 101 Switching Protocols. Right for direct-
    #   to-nginx endpoints (e.g. srv.tonel.io) where curl can complete RFC 6455
    #   handshake.
    # Mode "reachable": accept any non-zero HTTP code. Right for CF-Tunnel
    #   endpoints (e.g. api.tonel.io) where cloudflared edge may use HTTP/2 and
    #   curl-style upgrade is unreliable; we only care that cloudflared is
    #   reaching the backend at all. Real WS handshake is browser-tested.
    local url="$1" label="$2" mode="${3:-strict}"
    if [ "$DRY_RUN" = "1" ]; then
        dim "  [dry-run] would probe $label  $url (from server, mode=$mode)"
        return
    fi
    # curl returns 28 on max-time even after writing %{http_code} (the server
    # holds the WS connection open after the 101). Force trailing "; true" so
    # ssh exits 0 with curl's stdout (just the http code) intact.
    local code
    code=$(ssh -o ConnectTimeout=10 "$TONEL_SSH_HOST" \
        "curl -sk -o /dev/null -w '%{http_code}' \
            --max-time ${TONEL_HEALTH_TIMEOUT:-10} \
            -H 'Connection: Upgrade' \
            -H 'Upgrade: websocket' \
            -H 'Sec-WebSocket-Version: 13' \
            -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
            '$url' 2>/dev/null; true" 2>/dev/null)
    [ -z "$code" ] && code=000

    case "$mode" in
        strict)
            if [ "$code" = "101" ]; then
                ok "  wss  $label  101 Switching Protocols"
            else
                err "  wss  $label  HTTP $code (expected 101)"
                FAIL=1
            fi
            ;;
        reachable)
            if [ "$code" != "000" ]; then
                ok "  wss  $label  reachable (HTTP $code, real handshake browser-tested)"
            else
                err "  wss  $label  unreachable (HTTP 000)"
                FAIL=1
            fi
            ;;
    esac
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
check_wss_handshake "https://srv.tonel.io/mixer-tcp" "srv.tonel.io/mixer-tcp" strict
check_wss_handshake "https://srv.tonel.io/mixer-udp" "srv.tonel.io/mixer-udp" strict
check_wss_handshake "https://api.tonel.io/signaling" "api.tonel.io/signaling" reachable

if [ "$FAIL" = "0" ]; then
    ok "all health checks passed"
    exit 0
else
    err "$FAIL check(s) failed — investigate before declaring deploy successful"
    exit 1
fi
