# Tonel — Release Process

The single canonical way to ship a new version. **No bare commits to `main`.**
Every change to `main` must go through this flow.

## Before you start any release

Five-second sanity check that catches the cheapest mistakes:

1. `git status` is clean (or holds *only* the changes this release will ship)
2. `git rev-parse --abbrev-ref HEAD` is `main`
3. `git fetch && git log origin/main..HEAD` shows no surprise — i.e. you are
   ahead of `origin/main` by exactly the commits you intend to ship
4. **`Git/deploy/health.sh` returns all-green** (or notes any pre-existing
   warnings you'll want to distinguish from the ones your deploy might cause).
   This is the single most important step — it establishes the baseline so
   that if something breaks during the release, you know your release caused it.
5. `ssh "$TONEL_SSH_HOST" 'cat /opt/tonel/VERSION'` matches the latest tag
   on `main` (`git describe --tags --abbrev=0`). If it doesn't, find out why
   *before* shipping anything new.

## TL;DR

```bash
# 1. Make your changes on a branch (or directly if you're solo).
# 2. Update CHANGELOG.md with a new ## [X.Y.Z] - YYYY-MM-DD section.
# 3. Run the orchestrator:
Git/scripts/release.sh 1.0.4
```

That single command:

1. Bumps version in 5 files (CMakeLists × 3, web/package.json, config.schema.json)
2. Verifies `CHANGELOG.md` has an entry for the new version (hard-fail if not)
3. `git commit -m "release: v1.0.4"`
4. `git tag -a v1.0.4 -m v1.0.4`
5. **Pauses for confirmation** before `git push origin main --tags`
6. Deploys server (binaries + proxies + ops)
7. Deploys web (Cloudflare Pages)
8. Runs health check (port listeners + PM2 status + WSS handshake)

## Prerequisites

- Working tree clean (`git status` empty)
- On the `main` branch
- `Git/deploy/.env.deploy` exists (see [deploy/README.md](../deploy/README.md))
- SSH key authorized to `root@8.163.21.207`
- `CLOUDFLARE_API_TOKEN` valid (Pages — Edit permission)

## Versioning rules (semver)

| Bump | When |
|---|---|
| MAJOR | Breaking SPA1 protocol change, breaking API change, breaking DB schema |
| MINOR | New feature, new endpoint, new SPA1 message type, additive only |
| PATCH | Bug fix, refactor, drift cleanup, doc-only |

## CHANGELOG format (Keep a Changelog)

Required structure (the orchestrator hard-fails if it can't find this section):

```markdown
## [1.0.4] - 2026-04-30

### Fixed
- Description of fix.

### Added
- Description of new thing.

### Changed
- Description of behavior change.
```

Categories: `Added`, `Changed`, `Fixed`, `Deprecated`, `Removed`, `Security`.
Use only the categories you have. Entries focus on the **why**, not the diff.

## Partial flows

| Want to | Run |
|---|---|
| Bump + commit + tag + push, no deploy | `release.sh 1.0.4 --skip-deploy` |
| Bump + commit + tag locally, no push | `release.sh 1.0.4 --skip-push` |
| Re-deploy current HEAD (no version bump) | `release.sh deploy-only` |
| Hot-fix web only | `Git/deploy/web.sh` |
| Hot-fix proxy only | `Git/deploy/server.sh --component=proxy` |
| Roll back binaries | `Git/deploy/rollback.sh --component=binary` |

## Working on the deploy scripts themselves

If you're modifying anything in [`Git/deploy/`](../deploy/) or
[`Git/ops/`](../ops/), read [DEPLOY_SCRIPTING_STANDARDS.md](DEPLOY_SCRIPTING_STANDARDS.md)
first. Six bugs surfaced during the v1.0.3 → v1.0.4 release cycle —
each one became a rule. The case files are at
[deploy/LESSONS.md](../deploy/LESSONS.md).

## What NOT to do

- ❌ `git commit` directly on `main` without going through `release.sh`.
- ❌ `npm publish` or `wrangler pages deploy` from your laptop without the deploy
  script. Drift detection lives in `Git/deploy/server.sh`; bypassing it
  means the next real deploy will refuse to run until you reconcile.
- ❌ Edit files on `/opt/tonel/` directly. Edit in repo, commit, deploy.
- ❌ Tag without committing. Always `release.sh`.

## Hotfix workflow

If something is broken in production right now:

1. Identify the smallest possible fix in the repo.
2. Run `Git/scripts/release.sh <patch-version>` — full pipeline. The whole
   thing including health-check should take under 90 seconds.
3. If the fix breaks more than it solves, immediately
   `Git/deploy/rollback.sh --component=<binary|proxy>`.

There is no "manual hotfix on the server" path. The fastest way to fix
production is still through this pipeline because everything else assumes the
repo is the source of truth.
