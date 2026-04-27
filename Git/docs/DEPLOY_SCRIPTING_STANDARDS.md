# Deploy Scripting Standards

Normative rules for everything in [`Git/deploy/`](../deploy/) and [`Git/ops/`](../ops/).
Read this before writing or modifying a deploy script. Every rule below was
written down in response to a real production incident during the v1.0.3 /
v1.0.4 release cycle — see [LESSONS.md](../deploy/LESSONS.md) for the
case files.

These rules apply specifically to **shell scripts that drive remote
infrastructure**. They are deliberately narrower than general shell-scripting
advice: the failure modes here are mostly about (a) two shells composing
incorrectly across the SSH boundary, and (b) treating production as if it
were the laptop you are typing on.

---

## R1. Health probes run on the production server, not on the operator's laptop

A health check is asserting "the deploy is healthy", not "my home network
can reach the deploy". When the operator runs the script through a path that
applies SNI-based filtering, MITM, or geographically conditional QoS, a
laptop-side `curl` to a direct-to-origin endpoint may fail in ways that
have nothing to do with the deploy.

**Rule:** Any TCP/HTTP/WSS probe in `health.sh` (and equivalent verification
steps in deploy scripts) must run *on the production server* — i.e. wrapped
in `ssh -o ConnectTimeout=10 "$TONEL_SSH_HOST" "..."` — so the probe and the
service share an L3 path.

**Exceptions:** Probes that explicitly verify "external connectivity to the
public endpoint" (e.g. a smoke test for Cloudflare edge availability from a
known-good vantage point). These are uncommon and should be labelled as such.

**See:** [`health.sh:check_wss_handshake`](../deploy/health.sh).

---

## R2. `npm ci`, not `npm install`, in deploy paths

`npm install` mutates `package-lock.json` whenever transitive dependencies
shift. Running it inside a deploy script means every deploy potentially
leaves the working tree dirty, which (a) breaks `require_clean_git`-style
guards on the next deploy, and (b) makes the lockfile a moving target across
machines.

**Rule:** Deploy scripts that hydrate `node_modules/` must use `npm ci`. If
the script is the only path that installs dependencies for the artifact in
question, the lockfile is the contract.

**Corollary:** When invoking external tools that print warnings about a
"dirty git tree", inspect the dirtiness *before* silencing the warning —
the warning may be telling you the script itself is leaking changes.

**See:** [`web.sh`](../deploy/web.sh).

---

## R3. Boolean flag propagation uses a dedicated helper, not `${VAR:+...}`

`${VAR:+--flag}` expands `--flag` when `VAR` is **set and non-empty**, not
when `VAR` equals `1`. So with `DRY_RUN=0`, the parameter expansion still
emits `--flag`, and the child script silently runs in dry-run mode. The
parent looks fine; the child does nothing.

**Rule:** Use [`lib/common.sh:dry_run_flag`](../deploy/lib/common.sh) (or an
analogous helper) for any boolean-to-flag translation:

```bash
# WRONG — emits --dry-run for DRY_RUN=0 too
"$DEPLOY_DIR/server.sh" --component=ops ${DRY_RUN:+--dry-run}

# RIGHT — emits --dry-run only when DRY_RUN is exactly "1"
"$DEPLOY_DIR/server.sh" --component=ops $(dry_run_flag)
```

**Detection heuristic:** If a child script's banner reports `dry_run: 1`
when the parent is in real-run mode, suspect this. The bug is silent
otherwise — the only symptom is "nothing happened on the server".

---

## R4. Template substitution that may touch comments uses `awk`, not global `sed`

`sed 's/${TUNNEL_ID}/.../g'` over a template file replaces *every*
occurrence of the placeholder, including ones inside `#` comments and
docstrings. The applied artifact then no longer matches the template — the
template's own documentation has been mangled with the secret it was
explaining.

**Rule:** When substituting placeholders into a config template that
contains comment lines you want to preserve, use an `awk` rule that skips
comment lines:

```awk
/^[[:space:]]*#/ { print; next }
{ gsub(/\$\{TUNNEL_ID\}/, id); print }
```

This applies cleanly to most config formats whose comment marker is `#`
(YAML, nginx, sshd_config, systemd unit files). For formats with different
comment syntax, adapt the leading-pattern accordingly.

**See:** [`server.sh:deploy_ops`](../deploy/server.sh).

---

## R5. Remote shell variable expansion: define-then-double-quote, never single-quote

Composing a command for `ssh user@host "..."` requires you to keep track of
**which shell expands which variable**. There are two shells: the local one
where you build the command string, and the remote one that finally
executes it. Variables that should be filled in by the local shell expand
inside `"..."` normally. Variables that should expand on the remote side
must reach the remote shell with their `$` intact.

The trap: single quotes inside the outer `"..."` *do* prevent the local
shell from doing anything (they're just literal characters in a double-quoted
string), but they then arrive at the remote shell, which dutifully refuses
to expand `$name` inside *its* single quotes either. The result is files
named literally `$name`. This is what caused the v1.0.3 bootstrap outage.

**Rule:** When you need a path on the remote that mixes a locally-known
prefix with a remotely-defined variable, declare the prefix as a remote
shell variable in the heredoc prelude, then reference it via escaped-dollar
inside escaped-double-quotes:

```bash
ssh_exec "
    set -e
    DST=$TONEL_DEPLOY_DIR        # local: $TONEL_DEPLOY_DIR -> /opt/tonel
    for name in a b c; do
        cp src/\$name \"\$DST/\$name\"   # remote: $DST and $name expand here
    done
"
```

**Smoke-test recipe before trusting:** Replace the `cp` with `echo` and run
the script. If the printed paths look right, the real command will too.
This 30-second check would have caught the v1.0.3 bootstrap bug before it
hit production.

**See:** [`bootstrap.sh:[3/6] migrate`](../deploy/bootstrap.sh).

---

## R6. Capturing remote command stdout: `; true` + non-empty fallback, never `|| echo`

`code=$(ssh ... "curl ... '$url'" || echo "000")` looks reasonable but is
broken: if `curl` writes `%{http_code}=101` to stdout *and then* exits
non-zero (e.g. because `--max-time` fired after the WS upgrade), the `||`
branch *also* writes `000`. The two outputs are concatenated by `$()`,
producing nonsense like `101000` that no equality test will match.

**Rule:** Force the remote command to exit cleanly even on partial
failure, then handle empty capture explicitly:

```bash
# WRONG — concatenation if the inner command writes then fails
code=$(ssh ... "curl ... '$url'" 2>/dev/null || echo "000")

# RIGHT — `; true` makes the remote exit 0; empty capture means "nothing"
code=$(ssh ... "curl ... '$url' 2>/dev/null; true" 2>/dev/null)
[ -z "$code" ] && code=000
```

This pattern also generalizes: any `$()` that captures *partial* output is
a hazard. If the remote may produce a value-then-fail sequence, use
`; true` to neutralize the failure on the remote and check emptiness on
the local.

**See:** [`health.sh:check_wss_handshake`](../deploy/health.sh).

---

## R7. Idempotency is a deploy-script feature, not an aspiration

Deploy scripts get re-run after partial failures. If a step is not
idempotent, the recovery path is "manually reason about what was already
applied" — which is exactly what the script existed to remove.

**Rule:** Each step must be safe to re-run. Concretely:

- `mkdir` → `mkdir -p`
- `ln` → `ln -sf`
- `pm2 delete` → `pm2 delete x 2>/dev/null || true`
- File copy → check whether destination already matches before copying
  (or accept idempotent overwrite with the same contents)
- Snapshot creation → guard with `if [ ! -d "$snapshot" ]; then ...`

**Anti-pattern:** A script that asks `confirm "have you already run X?"`.
If you have to ask, the script is not idempotent — fix that, not the
prompt.

---

## R8. Drift detection before destructive overwrite

When a deploy script overwrites a file on production (config, binary,
script), it is implicitly asserting "the production version is the version
the repo last shipped". When that assertion is wrong, the deploy silently
overwrites work the operator may have done by hand.

**Rule:** Before clobbering a file on production, md5-compare local vs.
remote. If they differ unexpectedly (i.e. the remote is not the version
this script's previous run installed), refuse to proceed unless the
operator opts in via `ALLOW_DRIFT=1`.

**Reflowing pattern:** When you discover drift, the right response is
usually *not* to clobber — it is to copy the remote version into the repo,
commit it as a "drift reflow", and then re-run the deploy. This is what
v1.0.3 did with `ws-proxy.js`.

**See:** [`lib/common.sh:check_remote_drift`](../deploy/lib/common.sh).

---

## R9. Every deploy writes its own audit row

When something is broken in production at 3 AM, the first question is
"what's actually running right now, and when was it deployed?" If the
answer requires reading shell history or guessing from `mtime`, you are
behind.

**Rule:** Each deploy component appends one line to
`$TONEL_DEPLOY_DIR/DEPLOY_LOG` with `<utc-timestamp> <component>
v<version> <commit-sha>`. Each release also overwrites
`$TONEL_DEPLOY_DIR/VERSION` with the plain version string.

`cat /opt/tonel/VERSION` and `cat /opt/tonel/DEPLOY_LOG` should answer
"what shipped, when, from which commit?" without any further tools.

**See:** [`lib/common.sh:write_deploy_log`](../deploy/lib/common.sh).

---

## R10. Verify on the remote before committing — `echo` is your friend

Most of the rules above describe failure modes that are invisible until
they hit production. The cheapest defense is a 30-second remote dry-run
of the *expansion semantics* before trusting them:

```bash
ssh "$HOST" "
    DST=$LOCAL_VAR
    for name in foo bar; do
        echo \"would: cp src/\$name \\\"\$DST/\$name\\\"\"
    done
"
```

If the printed lines name the right files, the real command does too.
This is faster than `--dry-run`, narrower in scope, and catches the
class of quoting bugs that `--dry-run` cannot (because `--dry-run`
itself goes through the same broken expansion).

**Rule:** When writing a non-trivial `ssh "..."` block — anything with
remote variable references, loops, or paths assembled from local + remote
fragments — verify expansion via `echo` on the remote first. Commit only
after you've watched the right strings come back.

---

## Cross-references

| Where | What |
|---|---|
| [DEPLOYMENT.md](DEPLOYMENT.md) | What the production environment looks like (declarative) |
| [RELEASE.md](RELEASE.md) | How to ship a new version (`release.sh <version>`) |
| [deploy/README.md](../deploy/README.md) | What each deploy script does (operator-facing) |
| [deploy/LESSONS.md](../deploy/LESSONS.md) | Case files: real incidents that produced the rules above |
| [ops/README.md](../ops/README.md) | What the production environment *should* look like (sources) |
