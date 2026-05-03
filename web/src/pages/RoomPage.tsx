import { useEffect, useRef, useState, useCallback } from 'react'
import { audioService } from '../services/audioService'
import type { PeerInfo } from '../types'
import { ChannelStrip } from '../components/ChannelStrip'
import { InputChannelStrip } from '../components/InputChannelStrip'
import { SettingsModal } from '../components/SettingsModal'
import { AudioDebugPanel, toggleAudioDebugPanel } from '../components/AudioDebugPanel'
import type { InputChannel } from '../services/audioService'

interface Props {
  roomId: string
  userId: string
  userProfile?: import('../types').UserProfile | null
  password?: string
  peers: PeerInfo[]
  onLeave: () => void
}

export function RoomPage({ roomId, userId, userProfile, peers, onLeave }: Props) {
  const [selfLevel, setSelfLevel] = useState(0)
  const [peerLevels, setPeerLevels] = useState<Record<string, number>>({})
  const [soloId, setSoloId] = useState<string | null>(null)  // null = no solo active
  const [isMuted, setIsMuted] = useState(false)
  // Independent of `isMuted`: this gates the local monitor (self-hear)
  // without affecting the mic the user sends to peers. Wired to the
  // MIXER section's self-strip mute button.
  const [monitorMuted, setMonitorMuted] = useState(false)

  // Input channels shown in INPUT TRACKS. We snapshot audioService state
  // on every render-relevant change (channel add/remove/device-swap +
  // periodic level poll for meters). Per-channel level is read from
  // each channel's analyser via audioService.getInputChannelLevel.
  const [inputChannels, setInputChannels] = useState<readonly InputChannel[]>([])
  const [channelLevels, setChannelLevels] = useState<Record<string, number>>({})
  const [inputDevices, setInputDevices]   = useState<MediaDeviceInfo[]>([])

  // Refresh the device list whenever it changes (cable plug, BT pair).
  // The browser fires 'devicechange' on `navigator.mediaDevices`.
  useEffect(() => {
    const refresh = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices()
        setInputDevices(all.filter(d => d.kind === 'audioinput'))
      } catch (err) {
        console.warn('[RoomPage] enumerateDevices failed:', err)
      }
    }
    void refresh()
    navigator.mediaDevices.addEventListener?.('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', refresh)
  }, [])

  // Re-read the channel list snapshot. Called after any add/remove/swap
  // mutation and once at mount (channel 0 created during init).
  const refreshChannels = useCallback(() => {
    setInputChannels([...audioService.getInputChannels()])
  }, [])

  // Poll per-channel meters at 10 Hz — same cadence as the existing
  // selfLevel poll. Cheap (analyser-tap RMS computation per channel).
  useEffect(() => {
    const tick = setInterval(() => {
      const next: Record<string, number> = {}
      for (const ch of audioService.getInputChannels()) {
        next[ch.id] = audioService.getInputChannelLevel(ch.id)
      }
      setChannelLevels(next)
      // v3.7.4: reconcile peerLevels with audioService snapshot so
      // departed users' strips actually disappear from MIXER. The
      // mixer-side LEVELS broadcast already removes them from
      // audioService.peerLevels (v3.4.0 fix); this poll propagates
      // that to React state. Replacing the whole record is fine —
      // it's small (<10 entries typically) and equality-by-content
      // is preserved when nothing changed (React skips renders).
      setPeerLevels(audioService.peerLevelsSnapshot)
    }, 100)
    return () => clearInterval(tick)
  }, [])
  const [copied, setCopied] = useState(false)
  const [latency, setLatency] = useState<number>(-1)
  // e2e = mouth-to-ear estimate (capture + RTT + server jitter + mix tick +
  // client ring + output device). Polled at 10 fps from audioService —
  // RTT alone updates only every 3 s on PONG, but ring-fill / jitter-target
  // changes faster, so reading it from the same fast timer that already
  // drives selfLevel keeps the displayed e2e responsive.
  const [e2e, setE2e] = useState<number>(-1)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const joinedRef = useRef(false)

  const [dbg, setDbg] = useState('')
  // Surface init / connect errors to the UI. Without this, mobile users
  // hit a silent failure (init throws → catch logs to console only →
  // user sees the room but no devices, no levels, no latency, and has
  // no clue why). The banner at least gives them — and the dev — a
  // human-readable line to debug from.
  const [initError, setInitError] = useState<string>('')
  const [retrying,  setRetrying]  = useState<boolean>(false)
  // v5.1.16: mixer-connect runs in a silent background retry loop —
  // `mixerConnecting=true` while we're still dialing, false once a
  // connection lands. UI only surfaces a subtle "正在连接服务器…" line
  // after a few seconds (so a fast happy-path attempt never flashes).
  const [mixerConnecting, setMixerConnecting] = useState<boolean>(true)
  // Set true on unmount so the silent-retry loop can bail out instead
  // of dialing forever in the background.
  const cancelledRef = useRef<boolean>(false)
  // High-output-latency hint. Bluetooth output (AirPods etc.) typically
  // reports `outputLatency` 100-200 ms — this single variable can blow
  // past every server-side optimisation we've done. We poll the value
  // for the first ~5 s of a session (Chrome only sets it after the
  // first audio quantum has actually played) and surface a dismissible
  // banner if it crosses the perceptible threshold.
  const [outputLatencyMs, setOutputLatencyMs] = useState<number>(0)
  const [outputHintDismissed, setOutputHintDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem('tonel.outputHintDismissed') === '1' } catch { return false }
  })
  const dismissOutputHint = useCallback(() => {
    try { sessionStorage.setItem('tonel.outputHintDismissed', '1') } catch {}
    setOutputHintDismissed(true)
  }, [])

  // Initialise audio + mixer in three explicitly-decoupled stages:
  //   1. callbacks (pure JS state setup, always succeeds)
  //   2. mic + AudioContext (can fail on mobile: iOS Safari's gesture-chain
  //      requirement for AudioContext.resume(), getUserMedia permission,
  //      sample-rate restrictions, etc.)
  //   3. mixer WebSockets + capture (can fail independently: WSS handshake,
  //      network, server reachability)
  //
  // Stage 3 runs even if stage 2 fails, so listening still works while
  // the mic error is surfaced to the banner. Capture is gated on stage 2
  // success — we don't try to send packets we can't produce.
  //
  // Wrapped in a useCallback so the "retry" button on the error banner
  // can re-run it inside a fresh user-gesture click handler. That's the
  // standard iOS Safari workaround for AudioContext / getUserMedia: the
  // first attempt (post-navigate from the password modal) may not count
  // as a user gesture, but a button tap unambiguously does.
  // Channel mutation helpers (defined inside the component so they can
  // close over `refreshChannels`).
  const handleAddInputChannel = useCallback(async () => {
    try {
      await audioService.addInputChannel('default')
      refreshChannels()
    } catch (err) {
      console.error('[RoomPage] addInputChannel failed:', err)
    }
  }, [refreshChannels])
  const handleRemoveInputChannel = useCallback((chId: string) => {
    if (audioService.removeInputChannel(chId)) refreshChannels()
  }, [refreshChannels])
  const handleInputChannelDevice = useCallback(async (chId: string, deviceId: string) => {
    try {
      await audioService.setInputChannelDevice(chId, deviceId)
      refreshChannels()
    } catch (err) {
      console.error('[RoomPage] setInputChannelDevice failed:', err)
    }
  }, [refreshChannels])

  const runInit = useCallback(async () => {
    setRetrying(true)
    setInitError('')
    // v3.7.4: peerLevels reconcile lives in the periodic poll below,
    // not in this per-uid callback. The callback only ever fires for
    // upserts (a peer's LEVEL broadcast updating their value), never
    // for deletions — so a peer who left would keep their stale
    // entry in this React state forever, which then kept their
    // ChannelStrip on screen via the union renderer.
    audioService.onLatency((ms) => setLatency(ms))

    let micOk = false
    try {
      await audioService.init()
      micOk = true
      refreshChannels()
    } catch (err) {
      console.error('[RoomPage] Audio init (mic + AudioContext) failed:', err)
      // Distinguish common error names so the user gets actionable hints.
      const errName = err instanceof Error ? err.name : ''
      const errMsg  = err instanceof Error ? err.message : String(err)
      let hint = ''
      if (errName === 'NotAllowedError' || errMsg.includes('Permission')) {
        hint = '（请检查浏览器麦克风权限）'
      } else if (errName === 'NotFoundError') {
        hint = '（找不到可用的麦克风设备）'
      } else if (errName === 'NotReadableError') {
        hint = '（麦克风被其他应用占用）'
      } else if (errName === 'OverconstrainedError') {
        hint = '（麦克风不支持请求的采样率）'
      } else if (errName === 'NotSupportedError' ||
                 errMsg.toLowerCase().includes('audiocontext')) {
        hint = '（AudioContext 创建失败 — 可能是浏览器自动播放限制，请点击下方"重试"按钮）'
      }
      setInitError(`麦克风/音频初始化失败：${errName || 'Error'}: ${errMsg}${hint}`)
    }

    // v5.1.16: mixer connect failures no longer surface as a red banner.
    // The user already gets a 3-attempt retry inside `connectMixer` itself
    // (v5.1.15 — handles the kufan DPI's intermittent TLS-RST injection;
    // see CHANGELOG v5.1.15 + the architectural diagnosis in the
    // pcap-evidenced 2026-05-04 session). When the in-call retries are
    // also exhausted, we now keep retrying *silently* in the background
    // with exponential backoff capped at 30 s. The user sees a subtle
    // "正在连接服务器…" indicator (set via `setMixerConnecting`) instead
    // of an alarming "混音服务器连接失败" banner that can only be cleared
    // by clicking 启用麦克风 (which under v5.1.15 does nothing the user
    // didn't already get from the internal retry).
    //
    // Why this is safe: a successful `connectMixer` is idempotent w.r.t.
    // its own state (it cleans up any stale sockets at entry), and the
    // mic side already finished above. We just keep dialing the mixer
    // until it picks up.
    //
    // Mic-permission failures (the other path that sets `initError`)
    // STILL show the red banner — those genuinely need user action
    // (grant permission / unblock device / etc.).
    setMixerConnecting(true)
    let attempt = 0
    while (true) {
      attempt++
      try {
        await audioService.connectMixer(userId, roomId)
        if (micOk) audioService.startCapture()
        setMixerConnecting(false)
        break
      } catch (err) {
        console.warn(`[RoomPage] Mixer connect attempt ${attempt} failed (will keep retrying):`, err)
        // Exp backoff: 1s, 2s, 4s, 8s, 16s, then capped at 30 s.
        const delay = Math.min(1000 * Math.pow(2, Math.min(attempt - 1, 5)), 30000)
        await new Promise(r => setTimeout(r, delay))
        // If user already left the room (component unmounted), bail out.
        if (cancelledRef.current) {
          setMixerConnecting(false)
          return
        }
      }
    }
    setRetrying(false)
  }, [userId, roomId])
  // Poll level+latency at 10fps (fast timer), debug info at 1fps (slow timer)
  useEffect(() => {
    const fast = setInterval(() => {
      setSelfLevel(audioService.currentLevel)
      setE2e(audioService.audioE2eLatency)
      setOutputLatencyMs(audioService.outputLatencyMs)
    }, 150)
    const slow = setInterval(() => {
      const cap = audioService.captureModeValue === 'worklet' ? 'wkt'
                : audioService.captureModeValue === 'script-processor' ? 'sp'
                : 'idle'
      const muteFlag = audioService.isMuted ? ' MUTED' : ''
      // rateScale shown as ppm offset from 1.0 — easier to read than 1.00237
      const ratePpm = ((audioService.playRateScale - 1.0) * 1e6) | 0
      const rateStr = ratePpm >= 0 ? `+${ratePpm}` : `${ratePpm}`
      // uid (first 14 chars) + peer counts from BOTH paths so a mismatch
      // between signaling (`peers=`) and mixer (`roomUsers=`) is visible
      // at a glance — that's the v3.4.x same-userId-collision pattern.
      const uidShort = (userId || '').slice(0, 14)
      const sr = audioService.actualSampleRate || 0
      setDbg(
        `uid=${uidShort} peers=${peers.length} roomUsers=${audioService.serverPeerCount} sr=${sr} ` +
        `mon=${audioService.monitorGainTarget.toFixed(2)} ` +
        `monProc=${audioService.monitorProcCalls} monIn=${audioService.monitorInSeen} monOut=${audioService.monitorOutWrote} monQ=${audioService.monitorQueueLen} ` +
        `ws=${audioService.audioWsState} cap=${cap} ` +
        `tx=${audioService.txCount} rx=${audioService.rxCount} play=${audioService.playCount} ` +
        `rxPeak=${audioService.rxLevelPeak.toFixed(3)} micClip=${audioService.captureClipCountValue} ` +
        `repri=${audioService.playReprimeCount} plc=${audioService.playPlcCount} gap=${audioService.rxSeqGapCount} ` +
        `ring=${audioService.playRingFill} rate=${rateStr}ppm${muteFlag}`
      )
    }, 500)   // 2 Hz → enough to see roomUsers transitions when peer joins/leaves
    return () => { clearInterval(fast); clearInterval(slow) }
  }, [])

  useEffect(() => {
    if (joinedRef.current) return
    joinedRef.current = true

    // Three-stage init — see retryMicInit for the per-stage rationale.
    cancelledRef.current = false
    void runInit()

    // Wire mixer SESSION_REPLACED. Pre-v3.3.3 this callback was defined
    // in audioService but never subscribed to from any UI surface, so a
    // displaced mixer ctx would log "Session replaced" and keep right on
    // sending audio — UDP packets continued, mixer's room.users still
    // counted the displaced uid, soloMode flipped, and the user heard
    // their own voice via the server fullMix loop. Now SESSION_REPLACED
    // on the mixer triggers the same clean-leave flow as the signaling
    // server's SESSION_REPLACED: bail out of the room, surface a notice.
    audioService.onSessionReplaced(() => {
      console.warn('[RoomPage] Mixer session replaced — leaving room')
      onLeave()
    })

    return () => {
      // v5.1.16: signal the silent-retry loop in runInit() to stop on
      // unmount, otherwise it keeps dialing the mixer forever after the
      // user has already left the room.
      cancelledRef.current = true
      audioService.stopCapture()
    }
  }, [])

  const toggleMute = () => {
    if (isMuted) {
      audioService.unmute()
    } else {
      audioService.mute()
    }
    setIsMuted(!isMuted)
  }

  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // Solo logic: when a channel is soloed, mute master gain unless it's the solo channel
  // Since mixer sends a single mixed stream, solo only works for self (mute others vs mute self)
  const handleSolo = useCallback((channelId: string, solo: boolean) => {
    setSoloId(solo ? channelId : null)
  }, [])

  // When solo changes, adjust master gain: if solo is on self, keep playing; if solo is on peer, mute (can't isolate in mix)
  useEffect(() => {
    if (soloId === null) {
      // No solo: restore normal gain
      audioService.setMasterGain(1.0)
    } else if (soloId === userId) {
      // Solo on self: mute mixer output (only hear own monitoring)
      audioService.setMasterGain(0)
    } else {
      // Solo on a peer: in mixer mode we can't isolate, keep playing
      audioService.setMasterGain(1.0)
    }
  }, [soloId, userId])

  // v3.5.1: faders now route per-channel.
  // - Peer strip (in MIXER): per-recipient gain server-side via PEER_GAIN.
  // - Self strip (in INPUT TRACKS): mic input gain (pre-send multiplier).
  // - Self strip (in MIXER, "YOU·Mon"): local monitor gain.
  // - Master gain (audioService.setMasterGain) is no longer driven by any
  //   fader; it stays at 1.0. Per-peer gain in MIXER replaces the prior
  //   "all faders → master gain" shortcut.
  const handlePeerVolume = useCallback((peerUid: string, gain: number) => {
    audioService.setPeerGain(peerUid, gain)
  }, [])
  // (Per-channel input gain handled by setInputChannelGain in the
  // multi-channel render path; the old global setInputGain has been
  // superseded by the per-channel architecture introduced in v3.6.0.)

  const selfPeak = selfLevel > 0 ? selfLevel * 1.1 : 0

  // Triple-tap the room ID to toggle the debug panel. Mobile-only path —
  // desktop uses Ctrl+Shift+D, both end up calling toggleAudioDebugPanel().
  // 600 ms window between consecutive taps; resets if the gap exceeds it
  // so a single tap (e.g. accidental brush) doesn't accumulate state.
  const tapTimes = useRef<number[]>([])
  const onRoomIdTap = useCallback(() => {
    const now = performance.now()
    // Drop taps older than 600 ms relative to this one.
    tapTimes.current = tapTimes.current.filter(t => now - t < 600)
    tapTimes.current.push(now)
    if (tapTimes.current.length >= 3) {
      tapTimes.current = []
      toggleAudioDebugPanel()
    }
  }, [])

  return (
    <div className="room-page">
      <header className="room-header">
        <div className="room-info">
          <div>
            <div className="room-label">房间号</div>
            <div
              className="room-id"
              onClick={onRoomIdTap}
              style={{ userSelect: 'none', cursor: 'default' }}
              title="(三连点切换调试面板)"
            >
              {roomId}
            </div>
          </div>
          <button className="btn-copy" onClick={copyRoomId}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>

        <button
          className="btn-settings"
          onClick={() => setSettingsOpen(true)}
          aria-label="设置"
        >
          ⚙ 设置
        </button>

        {/* 麦克风静音 */}
        <button
          className={`btn-mic-toggle ${isMuted ? 'muted' : ''}`}
          onClick={toggleMute}
        >
          {isMuted ? 'MIC OFF' : 'MIC ON'}
        </button>

        <div className="latency-display" title="端到端 = capture + RTT + server jitter + mix + client ring + output device">
          <span className="latency-label">延迟</span>
          <span className={`latency-value ${e2e < 0 ? 'offline' : e2e < 100 ? 'good' : e2e < 200 ? 'ok' : 'bad'}`}>
            {e2e < 0 ? '--' : `${e2e}ms`}
          </span>
          <span className="latency-sep">·</span>
          <span className="latency-sublabel">RTT</span>
          <span className={`latency-value latency-rtt ${latency < 0 ? 'offline' : latency < 50 ? 'good' : latency < 100 ? 'ok' : 'bad'}`}>
            {latency < 0 ? '--' : `${latency}ms`}
          </span>
        </div>

        <button className="btn-leave" onClick={onLeave}>离开房间</button>
      </header>
      {/* High output-latency hint. Threshold 30 ms catches Bluetooth
          (AirPods ~150 ms, generic BT 100-200 ms) without false
          positives on USB DACs (3-8 ms) or wired output (5-10 ms).
          Banner stays dismissed for the rest of the browser session. */}
      {!outputHintDismissed && outputLatencyMs > 30 && (
        <div
          role="status"
          style={{
            background: '#3b2a0d', color: '#ffe6b3', padding: '8px 24px',
            fontSize: 13, borderTop: '1px solid #7a5a1a',
            borderBottom: '1px solid #7a5a1a',
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}
        >
          <span style={{ flex: '1 1 auto' }}>
            ⚠ 检测到高延迟输出设备（约 {Math.round(outputLatencyMs)}ms）。蓝牙耳机会让端到端延迟增加 100ms 以上，建议改用有线耳机或 USB 声卡获取最佳低延迟体验。
          </span>
          <button
            onClick={dismissOutputHint}
            style={{
              fontSize: 12, padding: '4px 10px',
              background: 'transparent', color: '#ffe6b3',
              border: '1px solid #ffe6b3', borderRadius: 3, cursor: 'pointer',
            }}
          >
            知道了
          </button>
        </div>
      )}
      {/* v5.1.16: subtle "正在连接服务器…" line while the silent-retry
          loop in runInit() dials the mixer. Replaces the alarming red
          "混音服务器连接失败" banner — the retry loop handles it for
          the user, no interaction needed.
          Mic-permission failures still surface via `initError` below. */}
      {mixerConnecting && !initError && (
        <div
          role="status"
          style={{
            background: '#1c2530', color: '#9fb3c8', padding: '6px 24px',
            fontSize: 12, borderTop: '1px solid #2a3441',
            borderBottom: '1px solid #2a3441',
            display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: 4,
            background: '#facc15', animation: 'tonel-pulse 1.2s ease-in-out infinite',
          }} />
          <span>正在连接服务器…</span>
          <style>{`@keyframes tonel-pulse { 0%,100% { opacity: 0.4 } 50% { opacity: 1 } }`}</style>
        </div>
      )}
      {initError && (
        <div
          role="alert"
          style={{
            background: '#3b0d0d', color: '#fdd', padding: '8px 24px',
            fontSize: 13, borderTop: '1px solid #7a1a1a',
            borderBottom: '1px solid #7a1a1a',
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}
        >
          <span style={{ flex: '1 1 auto' }}>⚠ {initError}</span>
          <button
            disabled={retrying}
            style={{
              fontSize: 12, padding: '4px 12px',
              background: '#5a1a1a', color: '#fff',
              border: '1px solid #fdd', borderRadius: 3,
              cursor: retrying ? 'wait' : 'pointer',
              opacity: retrying ? 0.5 : 1,
            }}
            onClick={() => { void runInit() }}
          >
            {retrying ? '重试中…' : '🔄 启用麦克风'}
          </button>
          <button
            style={{
              fontSize: 12, padding: '4px 10px',
              background: 'transparent', color: '#fdd',
              border: '1px solid #fdd', borderRadius: 3, cursor: 'pointer',
            }}
            onClick={() => setInitError('')}
          >
            关闭
          </button>
        </div>
      )}
      <div style={{fontSize:'11px',color:'#0f0',padding:'4px 24px',background:'#000',fontFamily:'monospace'}}>
        {dbg}
        <button style={{marginLeft:12,fontSize:10,padding:'2px 8px'}} onClick={() => {
          // Test tone: 440Hz for 0.5s — verifies AudioContext output works
          const ctx = (audioService as any).audioContext
          if (!ctx) return
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.frequency.value = 440
          gain.gain.value = 0.3
          osc.connect(gain)
          gain.connect(ctx.destination)
          osc.start()
          osc.stop(ctx.currentTime + 0.5)
        }}>TEST TONE</button>
      </div>

      <div className="room-content">
        {/* MIXER — output bus.
            First strip: SELF MONITOR (volume = local self-hear gain,
            mute = stop hearing yourself). Distinct from the INPUT
            TRACKS strip below, which controls the mic going to peers.
            Followed by per-peer strips. */}
        <div className="mixer-section">
          <div className="mixer-header">
            <span className="mixer-label">MIXER</span>
            <span className="mixer-count">
              {/* +1 for self-monitor strip; max() so signaling/mixer
                  disagreement (e.g. peers=0 roomUsers=2) doesn't lie
                  about how many strips will render below. */}
              {Math.max(peers.length, Object.keys(peerLevels).filter(u => u !== userId).length) + 1} CH
            </span>
          </div>
          <div className="mixer-channels">
            <ChannelStrip
              key={`${userId}-mon`}
              peerId={`${userId}-mon`}
              name={`${userProfile?.nickname || 'YOU'} · Mon`}
              avatarUrl={userProfile?.avatarUrl}
              level={selfLevel}
              peak={selfPeak}
              isSelf
              isMuted={monitorMuted}
              onMute={(muted) => {
                setMonitorMuted(muted)
                audioService.setMonitorMuted(muted)
              }}
              onVolume={(v) => audioService.setMonitorBaseGain(v)}
            />
            {(() => {
              // Render peer strips from the UNION of two sources:
              //   (a) signaling `peers` — has nickname/avatar metadata.
              //   (b) mixer LEVELS keys (peerLevels) — every user the
              //       mixer is currently broadcasting to/from.
              // The two paths are independent; we'd seen sessions where
              // signaling reported `peers=0` while mixer reported
              // `roomUsers=2` (e.g., a flaky signaling reconnect after
              // create_room). Pre-v3.6.1 the strips disappeared whenever
              // signaling went quiet, even though audio was flowing.
              // The union keeps strips visible whenever EITHER path
              // confirms the peer exists; signaling metadata is layered
              // on when available.
              const byId = new Map<string, { id: string; name: string; avatar?: string }>()
              for (const p of peers) {
                byId.set(p.user_id, {
                  id:     p.user_id,
                  name:   p.nickname || p.user_id.slice(0, 8),
                  avatar: p.avatar_url,
                })
              }
              for (const uid of Object.keys(peerLevels)) {
                if (uid === userId) continue   // exclude self
                if (!byId.has(uid)) {
                  byId.set(uid, { id: uid, name: uid.slice(0, 8) })
                }
              }
              const list = Array.from(byId.values())
              if (list.length === 0) {
                return <p className="empty-hint">等待其他乐手加入…</p>
              }
              return list.map(p => {
                const pl = peerLevels[p.id] ?? 0
                return (
                  <ChannelStrip
                    key={p.id}
                    peerId={p.id}
                    name={p.name}
                    avatarUrl={p.avatar}
                    level={pl}
                    peak={pl > 0 ? pl * 1.1 : 0}
                    isSolo={soloId === p.id}
                    onSolo={(solo) => handleSolo(p.id, solo)}
                    onVolume={(v) => handlePeerVolume(p.id, v)}
                  />
                )
              })
            })()}
          </div>
        </div>

        {/* INPUT TRACKS — the user's mic inputs. One strip per channel,
            each with its own device selector, fader, and mute. The +
            button at the end adds another input that gets mixed in. */}
        <div className="mixer-section">
          <div className="mixer-header">
            <span className="mixer-label">INPUT TRACKS</span>
            <span className="mixer-count">{inputChannels.length} CH</span>
          </div>
          <div className="mixer-channels">
            {inputChannels.map((ch, idx) => (
              <InputChannelStrip
                key={ch.id}
                channelId={ch.id}
                deviceId={ch.deviceId}
                deviceLabel={ch.deviceLabel}
                level={channelLevels[ch.id] ?? 0}
                inputDevices={inputDevices}
                canRemove={inputChannels.length > 1}
                onDeviceChange={(did) => void handleInputChannelDevice(ch.id, did)}
                onMute={(m) => {
                  audioService.setInputChannelMuted(ch.id, m)
                  // Channel 0's mute also mutes the mic-to-peers bus
                  // (legacy `isMuted` state) so the existing MIC ON/OFF
                  // button in the header stays in sync. Other channels
                  // mute only that channel's contribution.
                  if (idx === 0) {
                    if (m) audioService.mute(); else audioService.unmute()
                    setIsMuted(m)
                  }
                }}
                onVolume={(v) => audioService.setInputChannelGain(ch.id, v)}
                onRemove={() => handleRemoveInputChannel(ch.id)}
              />
            ))}
            <button
              onClick={() => void handleAddInputChannel()}
              title="添加输入通道"
              style={{
                alignSelf: 'stretch', minWidth: 80, fontSize: 14,
                background: '#1a3a1a', color: '#9f9',
                border: '2px dashed #4a7a4a', borderRadius: 4,
                cursor: 'pointer', padding: '12px 8px',
              }}
            >
              ＋ 添加输入
            </button>
          </div>
        </div>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AudioDebugPanel />
    </div>
  )
}
