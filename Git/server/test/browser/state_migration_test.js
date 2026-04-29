#!/usr/bin/env node
// state_migration_test.js — localStorage schema-migration regression test.
//
// What it covers (that the existing browser_audio_test.js does NOT):
//   • The path users hit when upgrading from a prior Tonel version that
//     had different default tuning values. v4.1.1 introduced a schema
//     version on the saved-tuning blob; v4.1.2 hotfixed the
//     reset-to-defaults path that was applying STALE defaults even
//     after a successful schema discard. Both bugs were invisible to
//     all five existing pretest layers because Layer 2 launches a fresh
//     browser profile every time (no localStorage to upgrade from).
//
// Strategy:
//   Spawn the Vite dev server (so the test exercises the SAME audioService
//   code that gets bundled to production, including all its imports and
//   class-static initialization). Launch Chromium via Playwright. Inside
//   the page, dynamic-import audioService.ts, plant synthetic stale and
//   current saved-tuning blobs, invoke the private migration entry point
//   (`loadRoomTuningIntoState`) directly, read back the resulting state,
//   and assert.
//
// Two scenarios:
//   1. Stale blob (no `v` field) → discarded, defaults applied with
//      CURRENT default values (not the value of `v` they were saved at).
//      Specifically asserts `maxScale === 1.025` because v4.1.2 caught
//      a bug where this came back as 1.012 (the v3.x default).
//   2. Current blob (`v: 2`) with custom user values → preserved, user
//      values overlay (don't accidentally discard a valid current-schema
//      slot).
//
// Run:
//   node state_migration_test.js                 # full suite
//   node state_migration_test.js --headed        # visible browser
//   node state_migration_test.js --keep-server   # leave Vite running on exit (debug)
//
// Adding more scenarios:
//   When a future Phase release bumps TUNING_SCHEMA_VERSION, add a
//   scenario here that plants a v=N-1 blob and asserts it gets
//   discarded. The cost is one localStorage.setItem + one assertion
//   per release; the value is catching the same class of regression
//   automatically.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WEB_DIR   = path.join(REPO_ROOT, 'Git', 'web');

// ── CLI ─────────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const headed = args.includes('--headed');
const keep   = args.includes('--keep-server');

function log(...m)   { console.log('[migration-test]', ...m); }
function fail(msg)   { console.error('[migration-test] FAIL:', msg); process.exit(1); }

// ── Vite dev server lifecycle ───────────────────────────────────────────────
//
// We could `vite build` + serve dist/ instead, but that drops HMR /
// dev-server middleware and forces us to figure out the bundled module
// shape (which Vite mangles for production). Dev server keeps our
// dynamic import shape exactly as audioService.ts is written.
async function startViteDevServer() {
  log('starting vite dev server...');
  const proc = spawn('npm', ['run', 'dev', '--', '--port', '5174', '--strictPort'], {
    cwd: WEB_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  // Drain stdout/stderr so the spawned process doesn't block on a
  // full pipe buffer. We don't pattern-match against the banner
  // because Vite's output is ANSI-colourised even with FORCE_COLOR=0,
  // which tears literal substrings like "Local:" apart with escapes.
  // Probing the port is more reliable.
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});

  // Surface unexpected early death (port conflict, module resolution
  // error, etc.) — silent timeouts are the worst kind of test fail.
  proc.on('exit', (code, sig) => {
    if (code !== null && code !== 0) {
      console.error(`[migration-test] vite exited early: code=${code} sig=${sig}`);
    }
  });

  // Poll http://127.0.0.1:5174/ for a 200; first success = ready.
  // 30s ceiling covers cold start on a fresh node_modules (~10-20s).
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:5174/', { signal: AbortSignal.timeout(500) });
      if (res.ok || res.status === 200) {
        log('vite ready on http://127.0.0.1:5174');
        return proc;
      }
    } catch (_) { /* not yet */ }
    await sleep(250);
  }
  proc.kill();
  fail('vite dev server failed to start within 30s');
}

// ── Test scenarios ──────────────────────────────────────────────────────────
//
// All run inside the same Chromium page (cheaper than relaunching browser
// per scenario). Each scenario sets up its own localStorage state, runs
// the migration, asserts on the post-state, then cleans up.

async function runInPage(page) {
  // Each scenario returns { name, pass, message }. Aggregate at the end.
  return await page.evaluate(async () => {
    const out = [];
    const mod = await import('/src/services/audioService.ts');
    const svc = mod.audioService;
    const Cls = mod.AudioService;
    const loadFn = Cls.prototype.loadRoomTuningIntoState;

    // ── Scenario 1: stale (no `v`) → discard + apply CURRENT defaults ──
    {
      const ROOM = 'MIGTEST_S1', USER = 'TestUser';
      const KEY  = `tonel.tuning.${ROOM}:${USER}`;
      localStorage.setItem(KEY, JSON.stringify({
        // NO `v` field — represents v3.x / v4.0 era saved blob
        client: { primeTarget: 288, primeMin: 16, maxScale: 1.012, minScale: 0.988, rateStep: 0.00002 },
        server: { jitterTarget: 1, jitterMaxDepth: 8 },
      }));
      svc.userId = USER; svc.roomId = ROOM;
      loadFn.call(svc);
      const after  = { ...svc.tuning };
      const slotAfter = localStorage.getItem(KEY);

      const pass = (slotAfter === null
                 && after.maxScale === 1.025
                 && after.minScale === 0.975
                 && after.primeTarget === 1440);
      out.push({
        name: 'stale slot → discarded + current defaults applied',
        pass,
        message: pass ? 'OK' : `slotAfter=${slotAfter} after.maxScale=${after.maxScale} after.primeTarget=${after.primeTarget}`,
      });
      localStorage.removeItem(KEY);
    }

    // ── Scenario 2: current (v:N) → preserved with user's custom values ──
    {
      const ROOM = 'MIGTEST_S2', USER = 'TestUser';
      const KEY  = `tonel.tuning.${ROOM}:${USER}`;
      // Read the schema version the code currently uses by inspecting
      // a freshly-saved blob (we can't directly read the private static).
      // Plant a blob at exactly that version with user-customised values.
      const CURRENT_V = mod.AudioService.TUNING_SCHEMA_VERSION;
      localStorage.setItem(KEY, JSON.stringify({
        v: CURRENT_V,
        client: { primeTarget: 144, primeMin: 16, maxScale: 1.025, minScale: 0.975, rateStep: 0.00002 },
        server: { jitterTarget: 1, jitterMaxDepth: 8 },
      }));
      svc.userId = USER; svc.roomId = ROOM;
      loadFn.call(svc);
      const after = { ...svc.tuning };
      const slotAfter = localStorage.getItem(KEY);

      const pass = (slotAfter !== null
                 && after.primeTarget === 144
                 && after.primeMin === 16);
      out.push({
        name: 'current-schema slot → preserved + user values applied',
        pass,
        message: pass ? `OK (v=${CURRENT_V} preserved)` : `slotKept=${slotAfter !== null} primeTarget=${after.primeTarget} primeMin=${after.primeMin}`,
      });
      localStorage.removeItem(KEY);
    }

    // ── Scenario 3: empty / no slot → defaults applied (basic sanity) ──
    {
      const ROOM = 'MIGTEST_S3', USER = 'TestUser';
      svc.userId = USER; svc.roomId = ROOM;
      loadFn.call(svc);
      const after = { ...svc.tuning };
      const pass = (after.maxScale === 1.025 && after.primeTarget === 1440);
      out.push({
        name: 'no-slot → defaults applied',
        pass,
        message: pass ? 'OK' : `after.maxScale=${after.maxScale} after.primeTarget=${after.primeTarget}`,
      });
    }

    // Reset svc state so we don't pollute future page evals
    svc.userId = ''; svc.roomId = '';
    return out;
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
let viteProc = null;
let browser  = null;
try {
  viteProc = await startViteDevServer();
  // Vite says "Local:" but the server may still need a beat for the
  // route handler to register. Probe quickly.
  await sleep(500);

  log(`launching chromium${headed ? ' (headed)' : ''}...`);
  browser = await chromium.launch({ headless: !headed });
  const page = await browser.newPage();
  // Surface page console errors so a real test failure (vs assertion) shows context.
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('  [page console]', msg.text());
  });
  page.on('pageerror', (err) => console.error('  [page error]', err.message));

  await page.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle', timeout: 15000 });

  const results = await runInPage(page);

  let failed = 0;
  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    log(`  ${tag} — ${r.name}: ${r.message}`);
    if (!r.pass) failed++;
  }

  if (failed > 0) fail(`${failed} of ${results.length} scenarios failed`);
  log(`all ${results.length} scenarios passed`);
} finally {
  if (browser) try { await browser.close(); } catch {}
  if (viteProc && !keep) {
    try { viteProc.kill('SIGTERM'); } catch {}
    // Vite leaves a child esbuild process around briefly; give it a sec.
    await sleep(200);
  }
}
