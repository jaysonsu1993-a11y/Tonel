#!/bin/bash
# Common functions for all deploy/*.sh scripts.
# Source this from a deploy script:  source "$(dirname "$0")/lib/common.sh"

set -euo pipefail

# ─── Paths ───────────────────────────────────────────────────────────────────

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo/deploy
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"                       # repo root
# Back-compat alias (pre-flatten code referenced GIT_DIR for what is now
# the repo root; some external scripts may still source this).
GIT_DIR="$REPO_ROOT"

ENV_FILE="$DEPLOY_DIR/.env.deploy"

# ─── Logging ─────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
    C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_GRN=$'\033[32m'
    C_DIM=$'\033[2m';  C_BLD=$'\033[1m';  C_RST=$'\033[0m'
else
    C_RED=; C_YEL=; C_GRN=; C_DIM=; C_BLD=; C_RST=
fi

log()  { printf '%s[deploy]%s %s\n'           "$C_BLD" "$C_RST" "$*"; }
ok()   { printf '%s[deploy]%s %s%s%s\n'       "$C_BLD" "$C_RST" "$C_GRN" "$*" "$C_RST"; }
warn() { printf '%s[deploy]%s %s%s%s\n'       "$C_BLD" "$C_RST" "$C_YEL" "$*" "$C_RST" >&2; }
err()  { printf '%s[deploy]%s %sERROR:%s %s\n' "$C_BLD" "$C_RST" "$C_RED" "$C_RST" "$*" >&2; }
die()  { err "$*"; exit 1; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RST"; }

# ─── DRY_RUN ─────────────────────────────────────────────────────────────────

DRY_RUN="${DRY_RUN:-0}"
run() {
    if [ "$DRY_RUN" = "1" ]; then
        printf '%s[dry-run]%s %s\n' "$C_DIM" "$C_RST" "$*" >&2
    else
        eval "$@"
    fi
}

# Use as `$(dry_run_flag)` when invoking child scripts, instead of
# `${DRY_RUN:+--dry-run}` (which expands for DRY_RUN=0 too — `:+` tests
# "is set", not "is 1").
dry_run_flag() {
    [ "$DRY_RUN" = "1" ] && echo "--dry-run"
    return 0
}

# ─── Env loading ─────────────────────────────────────────────────────────────

load_env() {
    [ -f "$ENV_FILE" ] || die "missing $ENV_FILE — copy from .env.deploy.example and fill in"

    # Preserve inline overrides — `source` would otherwise overwrite any
    # var we set on the command line (e.g.
    # `TONEL_SSH_HOST=... deploy/server.sh ...` to target the Aliyun
    # fallback box without editing .env.deploy). Snapshot the pre-source
    # state, source the file, then restore any var that was already set.
    # README documents this as the canonical way to address Aliyun in the
    # post-v5 dual-server setup.
    local _pre_ssh_host="${TONEL_SSH_HOST:-}"
    local _pre_ssh_port="${TONEL_SSH_PORT:-}"
    local _pre_tunnel="${TONEL_CF_TUNNEL_ID:-}"
    local _pre_deploy_dir="${TONEL_DEPLOY_DIR:-}"
    local _pre_runtime_dir="${TONEL_RUNTIME_DIR:-}"
    local _pre_log_dir="${TONEL_LOG_DIR:-}"
    local _pre_archive_dir="${TONEL_ARCHIVE_DIR:-}"

    set -a; source "$ENV_FILE"; set +a

    [ -n "$_pre_ssh_host" ]    && TONEL_SSH_HOST="$_pre_ssh_host"
    [ -n "$_pre_ssh_port" ]    && TONEL_SSH_PORT="$_pre_ssh_port"
    [ -n "$_pre_tunnel" ]      && TONEL_CF_TUNNEL_ID="$_pre_tunnel"
    [ -n "$_pre_deploy_dir" ]  && TONEL_DEPLOY_DIR="$_pre_deploy_dir"
    [ -n "$_pre_runtime_dir" ] && TONEL_RUNTIME_DIR="$_pre_runtime_dir"
    [ -n "$_pre_log_dir" ]     && TONEL_LOG_DIR="$_pre_log_dir"
    [ -n "$_pre_archive_dir" ] && TONEL_ARCHIVE_DIR="$_pre_archive_dir"

    : "${TONEL_SSH_HOST:?TONEL_SSH_HOST not set in .env.deploy}"
    : "${TONEL_DEPLOY_DIR:?TONEL_DEPLOY_DIR not set in .env.deploy (e.g. /opt/tonel)}"
    : "${TONEL_RUNTIME_DIR:?TONEL_RUNTIME_DIR not set in .env.deploy (e.g. /var/lib/tonel)}"
    : "${TONEL_LOG_DIR:?TONEL_LOG_DIR not set in .env.deploy (e.g. /var/log/tonel)}"
    : "${TONEL_ARCHIVE_DIR:?TONEL_ARCHIVE_DIR not set in .env.deploy (e.g. /opt/_archive)}"

    # SSH port — default 22; v5.0+ production (酷番云) is 26806. Exported
    # so child scripts that source common.sh see it without re-loading.
    export TONEL_SSH_PORT="${TONEL_SSH_PORT:-22}"
    export TONEL_SSH_HOST TONEL_CF_TUNNEL_ID TONEL_DEPLOY_DIR \
           TONEL_RUNTIME_DIR TONEL_LOG_DIR TONEL_ARCHIVE_DIR
}

# ─── Git state ───────────────────────────────────────────────────────────────

require_clean_git() {
    cd "$REPO_ROOT"
    if [ -n "$(git status --porcelain)" ]; then
        git status --short
        die "working tree dirty — commit or stash before deploying"
    fi
}

get_version() {
    sed -nE 's/^project\(Tonel VERSION ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' \
        "$REPO_ROOT/CMakeLists.txt" | head -1
}

get_commit() {
    git -C "$REPO_ROOT" rev-parse --short HEAD
}

# ─── SSH wrappers ────────────────────────────────────────────────────────────

ssh_exec() {
    # Usage: ssh_exec "<remote command>"
    if [ "$DRY_RUN" = "1" ]; then
        printf '%s[dry-run ssh]%s %s\n' "$C_DIM" "$C_RST" "$1" >&2
    else
        ssh -p "$TONEL_SSH_PORT" -o ConnectTimeout=10 "$TONEL_SSH_HOST" "$1"
    fi
}

ssh_quiet() {
    # Like ssh_exec but suppresses output (for probes that we only care about exit code)
    if [ "$DRY_RUN" = "1" ]; then
        return 0
    else
        ssh -p "$TONEL_SSH_PORT" -o ConnectTimeout=10 "$TONEL_SSH_HOST" "$1" >/dev/null 2>&1
    fi
}

rsync_to_remote() {
    # Usage: rsync_to_remote <local-path> <remote-path>
    # Pass --no-delete via RSYNC_FLAGS to override the default --delete
    # (necessary when the remote path is a single file, not a directory).
    local src="$1" dst="$2"
    local flags="${RSYNC_FLAGS:---delete}"
    if [ "$DRY_RUN" = "1" ]; then
        printf '%s[dry-run rsync]%s %s → %s:%s (flags: -avz %s)\n' \
            "$C_DIM" "$C_RST" "$src" "$TONEL_SSH_HOST" "$dst" "$flags" >&2
    else
        # shellcheck disable=SC2086
        rsync -avz -e "ssh -p $TONEL_SSH_PORT -o ConnectTimeout=10" $flags "$src" "$TONEL_SSH_HOST:$dst"
    fi
}

# ─── Drift detection ─────────────────────────────────────────────────────────

# Compare a local file (in repo) against the remote-installed version. Aborts
# the deploy if the remote has unexpected changes — caller must either commit
# the change to git or revert it on the server.
check_remote_drift() {
    local local_path="$1" remote_path="$2"
    local label="${3:-$(basename "$remote_path")}"

    if [ "$DRY_RUN" = "1" ]; then
        dim "  [dry-run] would diff $label between repo and remote"
        return 0
    fi

    local remote_md5 local_md5
    remote_md5=$(ssh -p "$TONEL_SSH_PORT" -o ConnectTimeout=10 "$TONEL_SSH_HOST" "md5sum '$remote_path' 2>/dev/null | awk '{print \$1}'") || remote_md5=""
    local_md5=$(md5 -q "$local_path" 2>/dev/null || md5sum "$local_path" 2>/dev/null | awk '{print $1}')

    if [ -z "$remote_md5" ]; then
        dim "  $label: not yet on remote (will install)"
    elif [ "$remote_md5" = "$local_md5" ]; then
        dim "  $label: clean ($remote_md5)"
    else
        warn "$label drift — remote ($remote_md5) ≠ repo ($local_md5)"
        if [ "${ALLOW_DRIFT:-0}" != "1" ]; then
            die "remote drift — re-sync repo from remote, or set ALLOW_DRIFT=1 to overwrite"
        fi
    fi
}

# ─── Confirmation ────────────────────────────────────────────────────────────

confirm() {
    local prompt="${1:-Continue?}"
    if [ "${YES:-0}" = "1" ]; then
        log "$prompt → auto-yes (YES=1)"
        return 0
    fi
    read -rp "$prompt [y/N] " ans
    [[ "$ans" =~ ^[yY]$ ]] || die "aborted by user"
}

# ─── Remote backup ───────────────────────────────────────────────────────────

backup_remote_dir() {
    # Snapshot a remote directory to TONEL_ARCHIVE_DIR with timestamp.
    # Returns the archive path on stdout.
    local src="$1"
    local stamp
    stamp=$(date +%Y%m%d-%H%M%S)
    local dst="$TONEL_ARCHIVE_DIR/$(basename "$src")-$stamp"

    ssh_exec "mkdir -p '$TONEL_ARCHIVE_DIR' && cp -a '$src' '$dst' && echo BACKUP_OK"
    echo "$dst"
}

# ─── Deploy log ──────────────────────────────────────────────────────────────

write_deploy_log() {
    local component="$1" version="$2" commit="$3"
    local stamp
    stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    ssh_exec "echo '$stamp  $component  v$version  $commit' >> '$TONEL_DEPLOY_DIR/DEPLOY_LOG'"
}
