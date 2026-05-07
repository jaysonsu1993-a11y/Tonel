# Tonel — Release Process

The single canonical way to ship a new version. **No bare commits to `main`.**
Every change to `main` must go through this flow.

This doc is the entry point for any AI agent or human contributor onboarding
to the project's release flow. Reading it cover-to-cover gives you everything
you need to ship a release end-to-end without prior context.

## TL;DR

```bash
# 1. Make your changes (any branch). Commit them.
# 2. Add a CHANGELOG.md ## [X.Y.Z] - YYYY-MM-DD section at the top.
# 3. Run the orchestrator from a Mac with Xcode installed:
scripts/release.sh 6.5.15
```

That single command runs an 8-step pipeline that ships to **every**
target platform. After it finishes:

- `https://tonel.io` serves the new web build
- `https://download.tonel.io/Tonel-MacOS-latest.dmg` serves the new mac
  installer
- `https://download.tonel.io/Tonel-Windows-latest.exe` serves the new
  Windows installer (built async by GitHub Actions, lands ~3 min after
  tag push)
- The mixer + signaling C++ binaries are running on both 广州1 (Aliyun)
  and 广州2 (Kufan) at the new version
- A new GitHub Release exists with the Windows .exe attached

If you skip writing a CHANGELOG entry, the script hard-fails at step 2.
This is intentional — every release must be self-documenting.

## The 8-step pipeline

| # | Step                                | Where it runs       | What can go wrong |
|---|-------------------------------------|---------------------|-------------------|
| 0 | `scripts/pretest.sh`                | local               | Layer 1 (server unit tests) / Layer 2 (audio quality) / Layer 6 (state migration) — see `feedback_state_migration_test` |
| 1 | `scripts/bump-version.sh`           | local               | Bumps CMakeLists × 2 + web/package.json |
| 2 | CHANGELOG check                     | local               | Hard-fail if no `## [X.Y.Z]` line |
| 3 | `git commit + tag + push`           | local → GitHub      | **Tag push triggers Windows CI in parallel** (`.github/workflows/build-installer.yml`) |
| 4 | `deploy/package-macos.sh` + `upload-r2.sh` | local Mac    | xcodebuild Release + ad-hoc codesign + hdiutil → wrangler R2 push |
| 5 | `deploy/server.sh` → 广州1 (Aliyun) | local → 8.163.21.207:22 | Cross-compile via Docker → rsync → PM2 reload |
| 6 | `deploy/server.sh` → 广州2 (Kufan)  | local → 42.240.163.172:26806 | Same, second box |
| 7 | `deploy/web.sh`                     | local → CF Pages    | `npm run build` → `wrangler pages deploy` |
| 8 | URL verify                          | local → public CDN  | curl HTTP 200 on R2 + tonel.io |

Step 3's tag push fires the Windows CI **asynchronously**. The
orchestrator doesn't block on it. By the time step 8 finishes (~5 min
into the run), the Windows .exe is usually already on R2 too — but not
guaranteed. The verify step warns (doesn't fail) if Windows-latest.exe
isn't yet updated.

## Prerequisites (one-time setup per machine)

| Item | What | How to verify |
|---|---|---|
| OS | macOS with Xcode installed | `xcodebuild -version` |
| .NET 8 SDK | optional (only for local Windows build, CI handles releases) | `dotnet --version` |
| Docker Desktop | for cross-compiling Linux binaries | `docker info` |
| Node 18+ + wrangler | `npm i -g wrangler` | `wrangler --version` |
| `deploy/.env.deploy` | from `.env.deploy.example`, fill in `CLOUDFLARE_API_TOKEN` (Pages + R2 Edit perms) + SSH host | `grep CLOUDFLARE_API_TOKEN deploy/.env.deploy` |
| SSH key on Aliyun | `root@8.163.21.207:22` | `ssh -p 22 root@8.163.21.207 whoami` |
| SSH key on Kufan  | `root@42.240.163.172:26806` | `ssh -p 26806 root@42.240.163.172 whoami` |
| GitHub Actions secret `CLOUDFLARE_API_TOKEN` | for CI Windows R2 push | Repo Settings → Secrets → Actions |

If any of these are missing, the script fails noisily at the first
affected step. Re-run after fixing.

## CHANGELOG format (Keep a Changelog)

Required structure (the orchestrator hard-fails if it can't find this
section):

```markdown
## [6.5.15] - 2026-05-08

### Fixed
- Description of fix (focus on **why**, not the diff).

### Added
- New thing.

### Changed
- Behaviour delta.
```

Categories: `Added`, `Changed`, `Fixed`, `Deprecated`, `Removed`,
`Security`. Use only the categories that have entries.

## Versioning rules (semver)

| Bump | When |
|---|---|
| MAJOR | Breaking SPA1 protocol change (e.g. v6.0.0 frame size 120 → 32) |
| MINOR | New feature, new endpoint, new SPA1 codec, additive only |
| PATCH | Bug fix, infrastructure tweak, doc-only change |

## Distribution outputs (where users actually get the bits)

```
                          tonel.io home page
                                 │
                                 │ <a href> pills
                                 ▼
                  download.tonel.io  (CF R2 custom domain)
                                 │
                                 ▼
                   r2://tonel-downloads/
                       │
                       ├─ Tonel-MacOS-vX.Y.Z.dmg
                       ├─ Tonel-MacOS-latest.dmg     ← always-newest alias
                       ├─ Tonel-Windows-vX.Y.Z.exe
                       └─ Tonel-Windows-latest.exe   ← always-newest alias
```

The `*-latest` aliases are what the home-page download buttons point at.
That means **the web doesn't need to redeploy for users to get a fresh
installer** — just push the new file to R2 (which the release script
does automatically).

End users see:
- macOS: right-click → 打开 → "无法验证开发者" → 打开 (ad-hoc signed,
  no Apple notarization yet — see `project_distribution_v6_5` memory)
- Windows: 更多信息 → 仍要运行 (unsigned, no SmartScreen reputation yet)

## Partial flows

| Want to | Run |
|---|---|
| Full release | `scripts/release.sh 6.5.15` |
| Bump + commit + tag + push, no deploy | `scripts/release.sh 6.5.15 --skip-deploy` |
| Bump + commit + tag locally, no push | `scripts/release.sh 6.5.15 --skip-push` |
| Re-deploy current HEAD (no version bump) | `scripts/release.sh deploy-only` |
| macOS dmg only | `deploy/package-macos.sh && deploy/upload-r2.sh deploy/dist/Tonel-MacOS-vX.Y.Z.dmg` |
| Server only (one box) | `TONEL_SSH_HOST=root@<ip> TONEL_SSH_PORT=<port> deploy/server.sh --component=binary` |
| Web only | `deploy/web.sh` |
| Health check (no deploy) | `deploy/health.sh` |
| Roll back binary | `deploy/rollback.sh --component=binary` |

## Hotfix flow

If production is broken now:

1. Identify the smallest possible fix in the repo.
2. Add a CHANGELOG.md `## [<patch-version>]` entry describing it.
3. `scripts/release.sh <patch-version>`.
4. If the fix made things worse:
   `deploy/rollback.sh --component=binary`. Then revert the commit on
   `main` and run `release.sh` again with a clean fix.

There is no "manual SSH and edit a file on production" path. The repo
is the source of truth; bypassing release.sh leaves drift that breaks
the next deploy.

## What NOT to do

- ❌ `git commit` directly on `main` without `release.sh`.
- ❌ Manually `wrangler pages deploy` for a routine release. The
  orchestrator does it; bypassing it means CHANGELOG / version
  manifests fall out of sync.
- ❌ Edit files on `/opt/tonel/` (Aliyun / Kufan) directly. Edit
  locally → commit → release.
- ❌ Tag without committing. The orchestrator always commits + tags
  atomically.
- ❌ Push the same version twice. Bump the patch number even for
  trivial doc-only changes — every commit on `main` must trigger a
  fresh release flow.
- ❌ Skip the CHANGELOG entry. The orchestrator refuses; if you're
  tempted to skip, you're probably bypassing the wrong tool.

## Working on the deploy scripts themselves

If you're modifying anything in [`deploy/`](../deploy/) or
[`ops/`](../ops/) or `.github/workflows/`, read
[DEPLOY_SCRIPTING_STANDARDS.md](./DEPLOY_SCRIPTING_STANDARDS.md) first.
The R1–R10 rules came from real production incidents; each one is a
case file at [deploy/LESSONS.md](../deploy/LESSONS.md).

For the Windows CI workflow specifically, read the project memory
`feedback_windows_ci_traps.md` — it documents the 9 distinct CI
failures the v6.5.4 → v6.5.14 series uncovered. Most are environment
quirks (PowerShell argument-mode parsing, Inno Setup directive syntax,
GitHub-hosted Inno Setup not bundling language packs, GITHUB_TOKEN
default permissions) that won't reproduce locally.

## How an AI agent should run a release

Two cases.

### Case A: ship a feature/fix you just wrote

```
1. Make sure your code changes are committed (or stashed) and the
   working tree is clean.
2. Edit CHANGELOG.md — add a `## [X.Y.Z] - YYYY-MM-DD` section at
   the top. List Added / Changed / Fixed bullets focused on the why.
3. Commit the CHANGELOG: `git add CHANGELOG.md && git commit -m "docs: changelog for vX.Y.Z"`
4. Run `scripts/release.sh X.Y.Z`.
5. When it asks to push, type `y`.
6. Wait for it to finish (~5-7 min).
7. After it returns, glance at the verify step's URL list. All four
   should be `HTTP 200`. If `Tonel-Windows-latest.exe` is the previous
   version (Windows CI hasn't finished), wait 1-2 min and `curl -I` it
   manually to confirm.
8. Done.
```

### Case B: redeploy current HEAD (no code change)

```
scripts/release.sh deploy-only
```

Skips the bump/commit/tag/push and goes straight to the deploy steps
(macOS / dual server / web / verify). Useful for re-running after a
flaky network failure or after manually fixing something on a server.

### When things go wrong

The orchestrator's `set -euo pipefail` means any sub-step's non-zero
exit halts the rest. The terminal output makes it obvious which step
broke. Re-run after fixing — every sub-script is idempotent.

For Windows CI failures (which run async, not in the orchestrator's
shell), check `https://github.com/jaysonsu1993-a11y/Tonel/actions`.
The `check-runs/<id>/annotations` API exposes C# / iscc errors without
needing admin log access — see `feedback_windows_ci_traps` memory.
