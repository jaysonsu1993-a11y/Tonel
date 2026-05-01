# Deploy Script Lessons

A running log of real incidents that shaped `DEPLOY_SCRIPTING_STANDARDS.md` (internal, kept in `local_docs/Git-docs/`).
Each entry is a case file: what broke, what we thought it was, what it actually
was, what we changed. Append a new entry whenever a deploy mishap is worth
preserving — the goal is that future contributors recognize the same
anti-pattern in seconds rather than minutes.

Entries are reverse-chronological. The rule numbers (R1, R2, …) refer to
sections in the standards doc.

---

## 2026-04-28 — v1.0.7 → v1.0.8 release cycle

### Incident 7 — Local `server/build/` rsync'd to remote, polluting CMakeCache (new R)

**Symptom.** During `release.sh 1.0.7` the `[binary] remote build (cmake)`
step failed with `CMake Error: The current CMakeCache.txt directory
/opt/tonel/build-src/build/CMakeCache.txt is different than the directory
/Users/niko/project-s/Tonel/server/build where CMakeCache.txt was
created.` The release had already bumped, committed, tagged, and pushed
v1.0.7 by the time the failure surfaced — only the deploy was blocked.

**What we thought.** Stale remote build directory from a prior aborted
deploy.

**What it actually was.** `deploy/server.sh` ran
`rsync_to_remote "$REPO_ROOT/server/" "$TONEL_DEPLOY_DIR/build-src/"` with
the default `--delete` flag and **no excludes**. The laptop happened to
have a local `server/build/` (from a developer cmake run — the dir
is gitignored but rsync doesn't honor `.gitignore`) and a `.cache/`
clangd index. Both got pushed. The remote `cmake -B build` then refused
to use the polluted cache because its baked-in source path
(`/Users/niko/project-s/Tonel/...`) didn't match the remote tree.

**Impact.** Every contributor with a local `server/build/` would hit
this on first deploy. v1.0.7 was rescued by skipping `server.sh`
(the v1.0.7 change set was web-only, so the C++ binary was unchanged
and didn't need a redeploy) and shipping web via `web.sh` directly.

**Fix.** `server.sh`'s rsync now passes
`RSYNC_FLAGS="--delete --delete-excluded --exclude=build/ --exclude=.cache/"`
for the source-tree push. `--delete-excluded` self-heals any remote
trees that already received the polluted artifacts.

**Lesson.** rsync is not git-aware. Any local-only artifact directories
that should never reach the remote must be enumerated explicitly via
`--exclude` on the rsync call. `--delete-excluded` makes the rule
forward-and-backward idempotent so the next deploy cleans up the mess
the previous one made.

---

## 2026-04-28 — v1.0.3 → v1.0.4 release cycle

The first release that moved production from `/opt/tonel-server/` to
`/opt/tonel/` and shipped `deploy/` as the official deploy path.
Six distinct bugs surfaced during this release; one caused a real ~1
minute production outage. All were fixed within v1.0.4. The rules above
are the distilled lessons.

### Incident 1 — Literal `$name` files in `/opt/tonel/bin/` (R5, R10)

**Symptom.** PM2 ecosystem startup reported `Error: Script not found:
/opt/tonel/bin/signaling_server`. Inspection found a single file named
literally `$name` (255824 bytes, executable) in both `bin/` and `proxy/`.

**What we thought.** PM2 path mismatch.

**What it actually was.** The `[3/6] migrate` block in `bootstrap.sh`
embedded the destination path as `'$TONEL_DEPLOY_DIR/bin/\$name'` — a
single-quoted string inside a double-quoted heredoc. The local shell
expanded `$TONEL_DEPLOY_DIR`, then sent the rest verbatim. The remote
shell saw a single-quoted `$name` and refused to expand it, so the `cp`
command's destination was the literal four-character filename.

**Impact.** All four PM2 processes in the new ecosystem failed to find
their executables. ~1 minute of full production outage until the
emergency restore (re-pm2-start from `/opt/tonel-server/`) completed.

**Fix.** Define `DST=$TONEL_DEPLOY_DIR` once on the remote, then refer to
it via escape-dollar-inside-escape-double-quotes:
`cp src/\$name \"\$DST/bin/\$name\"`. The cleanup uses an explicit
`rm -f \"\$DST/bin/\\\$name\"` to remove leftovers from the buggy run.

**Lesson → R5, R10.** Always smoke-test remote expansion with `echo`
before trusting a non-trivial ssh block.

---

### Incident 2 — `${DRY_RUN:+--dry-run}` betrayed us in real-run mode (R3)

**Symptom.** Bootstrap step `[6/6]` reported `dry_run: 1` even though
the parent (bootstrap.sh) was running for real. nginx was not reloaded,
cloudflared not restarted, `DEPLOY_LOG` not written.

**What we thought.** `bash` was leaking some inherited variable.

**What it actually was.** Parameter expansion `${DRY_RUN:+--dry-run}`
expands when `DRY_RUN` is *set and non-empty*. The default in
`common.sh` is `DRY_RUN="${DRY_RUN:-0}"`, so `DRY_RUN=0` is "set,
non-empty" and the expansion fires — handing `--dry-run` to the child.

**Impact.** Half-finished bootstrap. We had to manually re-run
`server.sh --component=ops` to apply nginx and cloudflared.

**Fix.** Introduced `dry_run_flag()` in `common.sh` that emits
`--dry-run` only when `DRY_RUN = "1"`, and replaced `${DRY_RUN:+...}`
at the four call sites that propagated dry-run.

**Lesson → R3.** `:+` is "if set", not "if true". If a flag has true/
false semantics, the conversion to a CLI flag should go through a
helper that knows that.

---

### Incident 3 — `HTTP 101000` instead of `101` (R6)

**Symptom.** `health.sh` reported `wss srv.tonel.io/mixer-tcp HTTP 101000
(expected 101)` after the WSS-from-server fix. Curl on the server itself
clearly showed 101 in isolation.

**What we thought.** Garbled output, maybe encoding.

**What it actually was.** `curl --max-time 10 -w '%{http_code}' wss://...`
prints `101` to stdout immediately when the server upgrades the
connection, then keeps the WS open until the timeout fires, exiting with
status 28. The capture `code=$(ssh ... "curl ..." || echo "000")` saw
the `101` from the successful curl, then ran `echo "000"` because the
overall exit was non-zero, then `$(...)` concatenated both.

**Impact.** False health failure on every check. We almost rolled back
a perfectly healthy deploy.

**Fix.** Append `; true` inside the remote command to neutralize the
non-zero exit, and treat empty capture as `000` outside:

```bash
code=$(ssh ... "curl ... '$url' 2>/dev/null; true" 2>/dev/null)
[ -z "$code" ] && code=000
```

**Lesson → R6.** `$()` captures partial stdout even when the producer
fails. `|| echo` for a fallback is a footgun — make the producer
succeed, check emptiness afterwards.

---

### Incident 4 — WSS probes failed against a healthy deploy (R1)

**Symptom.** `srv.tonel.io/mixer-tcp -> 000` from the operator's laptop
even after both the server and Cloudflared sides were verified healthy.
Loopback curl from inside the server returned 200/101 cleanly.

**What we thought.** Deploy regression.

**What it actually was.** The operator's ISP path applies SNI-based TLS
filtering on TCP-443 connections to non-CF, non-allowlisted IPs.
Connection-reset-by-peer during TLS handshake. The deploy was healthy;
the operator's network path was the problem.

**Impact.** Wasted ~10 minutes investigating an imaginary regression
right after a real outage.

**Fix.** `check_wss_handshake` now SSH-runs `curl` on the production
server, so the probe is on the same network as nginx. Direct-to-nginx
endpoints use `strict` mode (require 101); CF-Tunnel endpoints use
`reachable` mode (any non-zero HTTP code) because curl's RFC 6455
upgrade is unreliable through HTTP/2-speaking edges.

**Lesson → R1.** Health checks must run from where the application
lives, not from where the operator types.

---

### Incident 5 — `${TUNNEL_ID}` in the cloudflared template's *comment* got replaced (R4)

**Symptom.** After applying the template, the file at
`/root/.cloudflared/config.yml` had the real tunnel id embedded in the
comment block that was supposed to *describe* the substitution.

**What we thought.** Cosmetic — and it was — but the template was lying
about itself.

**What it actually was.** `sed "s/\${TUNNEL_ID}/$ID/g"` is global, so
every occurrence is replaced, regardless of whether it's on a comment
line or a config line.

**Impact.** Low. Comments still readable, just embarrassing — the
docstring referenced `${TUNNEL_ID}` and on production it referenced
`339745d7-...`.

**Fix.** Use awk with a leading-pattern that skips comment lines:

```awk
/^[[:space:]]*#/ { print; next }
{ gsub(/\$\{TUNNEL_ID\}/, id); print }
```

**Lesson → R4.** Templating tools should respect the syntactic
distinction between "a placeholder you want replaced" and "a
description of a placeholder". `sed -g` does not.

---

### Incident 6 — Every web deploy left the working tree dirty (R2)

**Symptom.** After `web.sh` finished successfully, `git status` showed
`web/package-lock.json` modified. The next deploy script that
called `require_clean_git` would refuse to run.

**What we thought.** A vite or wrangler artifact.

**What it actually was.** `npm install` adjusts `package-lock.json` to
reflect any transitive dep updates that have happened since the lockfile
was last generated. On a deploy machine, this is exactly the wrong
behavior — we want the lockfile to be the contract.

**Impact.** Low (manual `git checkout` to clear the noise) but it
created a category of "deploy that left the repo dirty" that would
confuse any subsequent automated step.

**Fix.** `web.sh` now uses `npm ci`, which honors the lockfile strictly
and refuses to run if the lockfile is out of sync. Also `wrangler pages
deploy` gets `--commit-dirty=true` to silence its own warning about the
gitignored `dist/` build output.

**Lesson → R2.** Deploy paths use `npm ci`. The lockfile is the
contract.

---

## How to add an entry

When a deploy mishap turns out to be worth preserving:

1. Decide if the failure mode generalizes. If yes, add a new rule
   (R-something) to `DEPLOY_SCRIPTING_STANDARDS.md` (internal).
2. Append a case file here with sections: **Symptom / What we thought /
   What it actually was / Impact / Fix / Lesson → R#**.
3. Link both files from each other.

If a failure was case-specific and does not produce a generalizable rule,
record it here anyway — case files are useful even without an
accompanying rule, since they let future readers do failure-mode pattern
matching.
