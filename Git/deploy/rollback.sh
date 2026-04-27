#!/bin/bash
# Roll back binaries and/or proxy scripts to the most recent timestamped backup.
#
# Usage:
#   Git/deploy/rollback.sh --component=binary|proxy [--dry-run]
#
# This script does NOT touch nginx / cloudflared / pm2 ecosystem — those rarely
# need rollback, and if they do, restore manually from $TONEL_ARCHIVE_DIR.

source "$(dirname "$0")/lib/common.sh"

COMPONENT=
for arg in "$@"; do
    case "$arg" in
        --component=*) COMPONENT="${arg#--component=}" ;;
        --dry-run)     DRY_RUN=1 ;;
        *) die "unknown arg: $arg" ;;
    esac
done

[[ "$COMPONENT" =~ ^(binary|proxy)$ ]] || die "must pass --component=binary or --component=proxy"

load_env

case "$COMPONENT" in
    binary)
        log "rolling back binaries from most recent .bak.* in $TONEL_DEPLOY_DIR/bin/"
        ssh_exec "
            set -e
            cd '$TONEL_DEPLOY_DIR/bin'
            for name in signaling_server mixer_server; do
                latest=\$(ls -1t \${name}.bak.* 2>/dev/null | head -1 || true)
                if [ -z \"\$latest\" ]; then
                    echo \"  no backup found for \$name — skipping\" >&2
                    continue
                fi
                echo \"  restoring \$name from \$latest\"
                pm2 stop tonel-\${name%_server} 2>/dev/null || true
                cp \$latest \$name
                chmod +x \$name
                pm2 start tonel-\${name%_server} 2>/dev/null || pm2 startOrReload '$TONEL_DEPLOY_DIR/ops/ecosystem.config.cjs' --only tonel-\${name%_server}
            done
        "
        ;;
    proxy)
        log "rolling back proxy from most recent archive snapshot"
        ssh_exec "
            set -e
            latest=\$(ls -1td '$TONEL_ARCHIVE_DIR'/proxy-* 2>/dev/null | head -1 || true)
            [ -n \"\$latest\" ] || { echo 'no proxy archive found' >&2; exit 1; }
            echo \"  restoring proxy/ from \$latest\"
            rsync -a --delete \"\$latest/\" '$TONEL_DEPLOY_DIR/proxy/'
            pm2 reload tonel-ws-proxy tonel-ws-mixer-proxy
        "
        ;;
esac

ok "rollback ($COMPONENT) complete — run health.sh to verify"
"$DEPLOY_DIR/health.sh" $(dry_run_flag)
