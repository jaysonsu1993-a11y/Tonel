#!/bin/bash
# Install Tonel's shared git hooks. Run once per clone.
#
#   ./Git/scripts/install-hooks.sh
#
# Sets `core.hooksPath` to the in-repo `Git/scripts/hooks/` directory so the
# pre-push fence (and any future hooks) ships with the repo and survives
# `git clone` without manual symlinking.
#
# Branch protection on GitHub would enforce these rules server-side too,
# but requires GitHub Pro for private repositories — until then this hook
# is our only fence.

set -euo pipefail

repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
hooks_dir="Git/scripts/hooks"

if [[ ! -d "$repo_root/$hooks_dir" ]]; then
    echo "error: $hooks_dir not found at $repo_root" >&2
    exit 1
fi

chmod +x "$repo_root/$hooks_dir"/*

git -C "$repo_root" config core.hooksPath "$hooks_dir"

echo "✅ git core.hooksPath set to $hooks_dir"
echo "   active hooks:"
ls -1 "$repo_root/$hooks_dir" | sed 's/^/     /'
