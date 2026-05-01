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
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WEB_DIR   = path.join(REPO_ROOT, 'web');

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

    // Snapshot CURRENT defaults so the assertions below stay correct
    // across future Phase bumps (each Phase that touches DEFAULT_PB
    // will change these numbers, but the test logic stays the same:
    // post-discard state should equal whatever DEFAULT_PB currently is).
    const CURRENT_V = mod.AudioService.TUNING_SCHEMA_VERSION;
    const CUR_PT    = mod.AudioService.DEFAULT_PB.primeTarget;
    const CUR_MIN   = mod.AudioService.DEFAULT_PB.primeMin;
    const CUR_MAX   = mod.AudioService.DEFAULT_PB.maxScale;

    // ── Scenario 1: stale (no `v`) → discard + apply CURRENT defaults ──
    // Catches the v4.1.2 regression class: schema check passes but the
    // reset path applies stale constants. Asserts against live DEFAULT_PB
    // so this test self-updates as defaults move.
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
                 && after.maxScale === CUR_MAX
                 && after.primeTarget === CUR_PT
                 && after.primeMin === CUR_MIN);
      out.push({
        name: 'stale (no-v) slot → discarded + current defaults applied',
        pass,
        message: pass ? `OK (defaults: pt=${CUR_PT} pm=${CUR_MIN} max=${CUR_MAX})`
                      : `slotAfter=${slotAfter} after=${JSON.stringify(after)}`,
      });
      localStorage.removeItem(KEY);
    }

    // ── Scenario 2: PREVIOUS-version (v:CURRENT-1) → also discarded ──
    // Each phase bumps TUNING_SCHEMA_VERSION; this scenario asserts the
    // discard logic catches the version directly below current. Without
    // this, a future bump that breaks the `v < CURRENT` comparison (e.g.
    // typo'd to `<=` or wrong CURRENT_VERSION constant) would silently
    // preserve stale blobs.
    if (CURRENT_V > 1) {
      const ROOM = 'MIGTEST_S2_PREV', USER = 'TestUser';
      const KEY  = `tonel.tuning.${ROOM}:${USER}`;
      localStorage.setItem(KEY, JSON.stringify({
        v: CURRENT_V - 1,
        client: { primeTarget: 1440, primeMin: 128, maxScale: 1.025, minScale: 0.975, rateStep: 0.00002 },
        server: { jitterTarget: 1, jitterMaxDepth: 8 },
      }));
      svc.userId = USER; svc.roomId = ROOM;
      loadFn.call(svc);
      const after = { ...svc.tuning };
      const slotAfter = localStorage.getItem(KEY);

      const pass = (slotAfter === null
                 && after.primeTarget === CUR_PT
                 && after.primeMin === CUR_MIN);
      out.push({
        name: `prev-schema (v:${CURRENT_V - 1}) slot → discarded + current defaults applied`,
        pass,
        message: pass ? 'OK' : `slotAfter=${slotAfter} primeTarget=${after.primeTarget} primeMin=${after.primeMin}`,
      });
      localStorage.removeItem(KEY);
    }

    // ── Scenario 3: CURRENT (v:CURRENT) → preserved with user values ──
    // Catches "schema check too aggressive, eats valid current-schema
    // slots" regression. User values must overlay the defaults.
    {
      const ROOM = 'MIGTEST_S3_CUR', USER = 'TestUser';
      const KEY  = `tonel.tuning.${ROOM}:${USER}`;
      // Plant CURRENT-schema blob with user-customised values that
      // intentionally differ from the live DEFAULT_PB so we can tell
      // which one took effect.
      // v4.3.8: primeTarget has a runtime floor of primeMin+192. Pick
      // a custom value that's above the floor (primeMin=16 → floor=208)
      // AND distinct from the current default so we can tell which
      // value took effect. 480 satisfies both for any plausible default.
      const customPT = CUR_PT === 480 ? 528 : 480;
      localStorage.setItem(KEY, JSON.stringify({
        v: CURRENT_V,
        client: { primeTarget: customPT, primeMin: 16, maxScale: 1.025, minScale: 0.975, rateStep: 0.00002 },
        server: { jitterTarget: 1, jitterMaxDepth: 8 },
      }));
      svc.userId = USER; svc.roomId = ROOM;
      loadFn.call(svc);
      const after = { ...svc.tuning };
      const slotAfter = localStorage.getItem(KEY);

      const pass = (slotAfter !== null
                 && after.primeTarget === customPT
                 && after.primeMin === 16);
      out.push({
        name: `current-schema (v:${CURRENT_V}) slot → preserved + user values applied`,
        pass,
        message: pass ? `OK (custom pt=${customPT} preserved)`
                      : `slotKept=${slotAfter !== null} primeTarget=${after.primeTarget} primeMin=${after.primeMin}`,
      });
      localStorage.removeItem(KEY);
    }

    // ── Scenario 4: empty / no slot → defaults applied (basic sanity) ──
    {
      const ROOM = 'MIGTEST_S4_NONE', USER = 'TestUser';
      svc.userId = USER; svc.roomId = ROOM;
      loadFn.call(svc);
      const after = { ...svc.tuning };
      const pass = (after.maxScale === CUR_MAX && after.primeTarget === CUR_PT);
      out.push({
        name: 'no-slot → defaults applied',
        pass,
        message: pass ? 'OK' : `after.maxScale=${after.maxScale} after.primeTarget=${after.primeTarget}`,
      });
    }

    // ── Scenario 5: current-schema slot with primeTarget below the v4.3.8
    //    safety floor → preserved BUT clamped up to primeMin+192. A future
    //    code path (or hand-edited localStorage) could plant a sub-floor
    //    value; setPlaybackTuning's clamp must hold the runtime invariant
    //    so the worklet never enters the PLC-stacking zone the user
    //    reported on v4.3.7.
    {
      const ROOM = 'MIGTEST_S5_FLOOR', USER = 'TestUser';
      const KEY  = `tonel.tuning.${ROOM}:${USER}`;
      const SAVED_PM = 16;        // user's primeMin
      const SAVED_PT = 144;       // below floor (primeMin+192 = 208)
      const EXPECTED_PT = SAVED_PM + 192;   // 208
      localStorage.setItem(KEY, JSON.stringify({
        v: CURRENT_V,
        client: { primeTarget: SAVED_PT, primeMin: SAVED_PM,
                  maxScale: 1.025, minScale: 0.975, rateStep: 0.00002 },
        server: { jitterTarget: 1, jitterMaxDepth: 8 },
      }));
      svc.userId = USER; svc.roomId = ROOM;
      loadFn.call(svc);
      const after = { ...svc.tuning };
      const pass = (after.primeTarget === EXPECTED_PT
                 && after.primeMin === SAVED_PM);
      out.push({
        name: `sub-floor primeTarget (${SAVED_PT}) → clamped to primeMin+192 (${EXPECTED_PT})`,
        pass,
        message: pass ? 'OK' : `primeTarget=${after.primeTarget} primeMin=${after.primeMin}`,
      });
      localStorage.removeItem(KEY);
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
