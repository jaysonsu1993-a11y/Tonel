import { useEffect, useState, useCallback } from 'react'
import { audioService } from '../services/audioService'

/**
 * AudioDebugPanel — live tuning sliders for the latency-critical knobs in
 * the audio path. Renders only when `?debug=1` is in the URL so it stays
 * out of the way for ordinary users.
 *
 * Five client-side knobs (postMessage → playback worklet, no audio graph
 * rebuild) and two server-side knobs (MIXER_TUNE → per-user jitter buffer
 * via the control WS). Numeric values converted to ms where it helps the
 * mental model — the engineer cares about latency, not sample counts.
 *
 * Adjustments are NOT persisted across reload — the goal is exploratory
 * sweeping, not configuration. If a value works, paste it back into the
 * defaults in audioService.ts (PRIME_TARGET / PRIME_MIN) or
 * mixer_server.h (JITTER_TARGET_DEFAULT / JITTER_MAX_DEPTH_DEFAULT).
 */
// sessionStorage key for the keyboard-toggle override. Survives navigation
// inside the SPA but not a full reload — matching the panel's "exploratory,
// not configuration" stance (don't lock end users into seeing it forever).
const DEBUG_OVERRIDE_KEY = 'tonel.debug.audioPanel'
// Custom event the panel listens to as a "re-check enabled state" trigger.
// Any place that flips DEBUG_OVERRIDE_KEY (keyboard shortcut here, triple-tap
// in RoomPage) dispatches this so the panel re-renders without remount.
const DEBUG_TOGGLE_EVENT = 'tonel:debug-toggle'

function readEnabled(): boolean {
  if (typeof location === 'undefined') return false
  if (new URLSearchParams(location.search).get('debug') === '1') return true
  try {
    return sessionStorage.getItem(DEBUG_OVERRIDE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Flip the debug-panel override and tell the panel to re-evaluate. Exported
 * so any UI surface — keyboard shortcut, triple-tap on room id, future
 * gesture — can trigger the same toggle without duplicating the
 * sessionStorage logic. The custom event is the cross-component nudge;
 * `popstate` would technically work but is semantically wrong (we're
 * not changing the URL).
 */
export function toggleAudioDebugPanel(): void {
  try {
    const cur = sessionStorage.getItem(DEBUG_OVERRIDE_KEY) === '1'
    sessionStorage.setItem(DEBUG_OVERRIDE_KEY, cur ? '0' : '1')
  } catch {}
  window.dispatchEvent(new CustomEvent(DEBUG_TOGGLE_EVENT))
}

export function AudioDebugPanel() {
  // Reactive enable: re-checked on popstate (so navigation that changes
  // the query string toggles the panel mid-session, not just at mount)
  // and via a global keyboard shortcut (Ctrl+Shift+D / ⌘⇧D) that flips a
  // sessionStorage override — the latter sidesteps the deep-link
  // password reentry that happens when the user manually edits ?debug=1
  // into the URL bar (full reload → /room/<id> deep-link → password).
  const [enabled, setEnabled] = useState(readEnabled)

  useEffect(() => {
    const refresh = () => setEnabled(readEnabled())
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Shift+D (or ⌘⇧D on macOS). KeyD is layout-independent.
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && e.code === 'KeyD') {
        e.preventDefault()
        toggleAudioDebugPanel()
      }
    }
    window.addEventListener('popstate', refresh)
    window.addEventListener('keydown', onKey)
    window.addEventListener(DEBUG_TOGGLE_EVENT, refresh as EventListener)
    return () => {
      window.removeEventListener('popstate', refresh)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(DEBUG_TOGGLE_EVENT, refresh as EventListener)
    }
  }, [])

  // Local mirror of audioService tuning, refreshed on every change so
  // server-acked clamps and MIXER_JOIN_ACK defaults flow into the UI.
  const [t, setT] = useState(audioService.tuning)
  const [s, setS] = useState(audioService.serverTuning)
  const [collapsed, setCollapsed] = useState(false)
  const [stats, setStats] = useState({
    rateScale:  1.0,
    ringFill:   0,
    reprime:    0,
    plc:        0,
    seqGap:     0,
    rxPeak:     0,
    serverUsers: 0,
  })

  useEffect(() => {
    if (!enabled) return
    const refresh = () => {
      setT({ ...audioService.tuning })
      setS({ ...audioService.serverTuning })
    }
    audioService.onTuningChanged(refresh)
    refresh()
    const tick = setInterval(() => {
      setStats({
        rateScale:   audioService.playRateScale,
        ringFill:    audioService.playRingFill,
        reprime:     audioService.playReprimeCount,
        plc:         audioService.playPlcCount,
        seqGap:      audioService.rxSeqGapCount,
        rxPeak:      audioService.rxLevelPeak,
        serverUsers: audioService.serverPeerCount,
      })
    }, 200)
    return () => clearInterval(tick)
  }, [enabled])

  const setPb = useCallback((field: keyof typeof t, value: number) => {
    audioService.setPlaybackTuning({ [field]: value } as Partial<typeof t>)
  }, [])
  const setSrv = useCallback((field: keyof typeof s, value: number) => {
    audioService.setServerTuning({ [field]: value } as Partial<typeof s>)
  }, [])

  // RESET wipes the saved per-room slot AND restores defaults across
  // worklet / server / UI. Different from "just drag sliders back to
  // defaults" — that would re-save the defaults; this clears the slot
  // entirely so leaving and rejoining the room sees server defaults
  // again with no override.
  const reset = useCallback(() => {
    audioService.resetRoomTuning()
  }, [])

  if (!enabled) return null

  // Derived display values. Sample-counts → ms uses the wire rate (48 kHz);
  // server frames → ms uses the 5 ms broadcast tick.
  const primeTargetMs = (t.primeTarget / 48).toFixed(1)
  const primeMinMs    = (t.primeMin    / 48).toFixed(1)
  const ringFillMs    = (stats.ringFill / 48).toFixed(1)
  const ratePpm       = ((stats.rateScale - 1) * 1e6) | 0
  const maxPpm        = ((t.maxScale  - 1) * 1e6) | 0
  const minPpm        = ((t.minScale  - 1) * 1e6) | 0
  // Phase B v4.2.0 halved the server mix tick from 5 ms to 2.5 ms, so
  // each jitter-buffer "frame" now represents 2.5 ms of audio (was
  // 5 ms). These display calcs were stuck on the old multiplier.
  const FRAME_MS = 2.5
  const jitterTargetMs = s.jitterTarget * FRAME_MS
  const jitterCapMs    = s.jitterMaxDepth * FRAME_MS

  // Latency budget surfaces the sum of the user-facing knobs. This is the
  // primary thing the engineer is here to minimise — show it large.
  const totalAddedMs = Number(primeTargetMs) + (s.jitterTarget - 0.5) * FRAME_MS

  return (
    <div style={{
      position: 'fixed', right: 12, bottom: 12, zIndex: 9999,
      background: 'rgba(0,0,0,0.92)', color: '#0f0',
      fontFamily: 'monospace', fontSize: 11,
      border: '1px solid #0f0', borderRadius: 4,
      padding: collapsed ? '6px 10px' : '10px 14px',
      maxWidth: 360, boxShadow: '0 2px 12px rgba(0,255,0,0.2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 'bold' }}>AUDIO DEBUG</span>
        <span>
          <button onClick={reset} style={btnStyle}>RESET</button>
          <button onClick={() => setCollapsed(!collapsed)} style={btnStyle}>
            {collapsed ? '+' : '−'}
          </button>
        </span>
      </div>
      {!collapsed && audioService.currentRoomId && (
        <div style={{ fontSize: 10, marginTop: 4, color: audioService.hasSavedTuning() ? '#ff0' : '#7a7' }}>
          {audioService.hasSavedTuning()
            ? `📍 saved for ${audioService.currentRoomId}:${audioService.currentUserId.slice(0, 8)}`
            : `📭 no override · room ${audioService.currentRoomId}`}
        </div>
      )}
      {!collapsed && (
        <>
          <div style={{ margin: '8px 0', padding: 6, background: '#001a00', borderRadius: 3 }}>
            <div>added latency budget: <b style={{ color: '#ff0' }}>{totalAddedMs.toFixed(1)} ms</b></div>
            <div>= client cushion {primeTargetMs} ms + server jitter ~{(s.jitterTarget - 0.5) * 5} ms</div>
          </div>
          <hr style={hrStyle} />
          <div style={sectionTitle}>CLIENT — playback worklet</div>
          {/* v4.3.8: lower bound = primeMin + 128 (one quantum) + 64
              (jitter cushion) to prevent the worklet from being driven
              into a state where every quantum mid-callback-underruns
              and fires PLC. PLC budget is 4 quanta; sustained
              underruns stack lastBlock replays into an audible echo
              "叠加" effect. The bound is dynamic on primeMin so the
              two sliders compose correctly. */}
          <Slider
            label="primeTarget" value={t.primeTarget}
            min={Math.max(240, t.primeMin + 192)} max={1600} step={48}
            display={`${t.primeTarget} samp · ${primeTargetMs} ms`}
            onChange={v => setPb('primeTarget', v)}
          />
          <Slider
            label="primeMin" value={t.primeMin} min={0} max={512} step={16}
            display={`${t.primeMin} samp · ${primeMinMs} ms`}
            onChange={v => setPb('primeMin', v)}
          />
          <Slider
            label="maxScale" value={t.maxScale} min={1.0001} max={1.05} step={0.0005}
            display={`${t.maxScale.toFixed(4)} · +${maxPpm} ppm`}
            onChange={v => setPb('maxScale', v)}
          />
          <Slider
            label="minScale" value={t.minScale} min={0.95} max={0.9999} step={0.0005}
            display={`${t.minScale.toFixed(4)} · ${minPpm} ppm`}
            onChange={v => setPb('minScale', v)}
          />
          <Slider
            label="rateStep" value={t.rateStep} min={0} max={0.0005} step={0.000005}
            display={`${(t.rateStep * 1e6).toFixed(1)} ppm/quantum`}
            onChange={v => setPb('rateStep', v)}
          />
          <hr style={hrStyle} />
          <div style={sectionTitle}>SERVER — per-user jitter buffer</div>
          <Slider
            label="jitterTarget" value={s.jitterTarget} min={1} max={16} step={1}
            display={`${s.jitterTarget} fr · ${jitterTargetMs} ms`}
            onChange={v => setSrv('jitterTarget', v)}
          />
          <Slider
            label="jitterMaxDepth" value={s.jitterMaxDepth} min={1} max={64} step={1}
            display={`${s.jitterMaxDepth} fr · ${jitterCapMs} ms cap`}
            onChange={v => setSrv('jitterMaxDepth', v)}
          />
          <hr style={hrStyle} />
          <div style={sectionTitle}>LIVE</div>
          <div>
            transport=<b style={{ color: audioService.audioTransport === 'wt' ? '#0ff' : audioService.audioTransport === 'wss' ? '#ff0' : '#888' }}>
              {audioService.audioTransport}
            </b>
          </div>
          <div>ring={stats.ringFill} samp · {ringFillMs} ms</div>
          <div>rate={ratePpm >= 0 ? '+' : ''}{ratePpm} ppm</div>
          <div>reprime={stats.reprime} · plc={stats.plc} · seqGap={stats.seqGap}</div>
          <div>rxPeak={stats.rxPeak.toFixed(3)} · roomUsers={stats.serverUsers}</div>
        </>
      )}
    </div>
  )
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (v: number) => void
}

function Slider({ label, value, min, max, step, display, onChange }: SliderProps) {
  return (
    <div style={{ margin: '4px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{label}</span>
        <span style={{ color: '#ff0' }}>{display}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#0f0' }}
      />
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  marginLeft: 4, background: '#000', color: '#0f0', border: '1px solid #0f0',
  fontFamily: 'monospace', fontSize: 10, padding: '2px 6px', cursor: 'pointer',
}
const hrStyle: React.CSSProperties = { border: 0, borderTop: '1px dashed #0a0', margin: '6px 0' }
const sectionTitle: React.CSSProperties = { fontWeight: 'bold', margin: '4px 0', color: '#9f9' }
