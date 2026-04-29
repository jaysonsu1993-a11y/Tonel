import { useEffect, useRef, useState, useCallback } from 'react'
import { audioService } from '../services/audioService'
import type { PeerInfo } from '../types'
import { ChannelStrip } from '../components/ChannelStrip'
import { SettingsModal } from '../components/SettingsModal'
import { AudioDebugPanel, toggleAudioDebugPanel } from '../components/AudioDebugPanel'

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
  const [copied, setCopied] = useState(false)
  const [latency, setLatency] = useState<number>(-1)
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
  const runInit = useCallback(async () => {
    setRetrying(true)
    setInitError('')
    audioService.onPeerLevel((uid, level) => {
      setPeerLevels(prev => ({ ...prev, [uid]: level }))
    })
    audioService.onLatency((ms) => setLatency(ms))

    let micOk = false
    try {
      await audioService.init()
      micOk = true
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

    try {
      await audioService.connectMixer(userId, roomId)
      if (micOk) audioService.startCapture()
    } catch (err) {
      console.error('[RoomPage] Mixer connect failed:', err)
      const msg = (err instanceof Error ? err.message : String(err)) || 'unknown error'
      setInitError(prev =>
        (prev ? prev + ' / ' : '') + `混音服务器连接失败：${msg}`
      )
    }
    setRetrying(false)
  }, [userId, roomId])
  // Poll level+latency at 10fps (fast timer), debug info at 1fps (slow timer)
  useEffect(() => {
    const fast = setInterval(() => {
      setSelfLevel(audioService.currentLevel)
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
        `repri=${audioService.playReprimeCount} gap=${audioService.rxSeqGapCount} ` +
        `ring=${audioService.playRingFill} rate=${rateStr}ppm${muteFlag}`
      )
    }, 500)   // 2 Hz → enough to see roomUsers transitions when peer joins/leaves
    return () => { clearInterval(fast); clearInterval(slow) }
  }, [])

  useEffect(() => {
    if (joinedRef.current) return
    joinedRef.current = true

    // Three-stage init — see retryMicInit for the per-stage rationale.
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

  const handleVolume = useCallback((gain: number) => {
    audioService.setMasterGain(gain)
  }, [])

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

        <div className="latency-display">
          <span className="latency-label">延迟</span>
          <span className={`latency-value ${latency < 0 ? 'offline' : latency < 50 ? 'good' : latency < 100 ? 'ok' : 'bad'}`}>
            {latency < 0 ? '--' : `${latency}ms`}
          </span>
        </div>

        <button className="btn-leave" onClick={onLeave}>离开房间</button>
      </header>
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
        {/* MIXER — peers' channel strips. Self is separated out into its
            own INPUT TRACKS section below so the input vs. output buses
            stay visually distinct (closer to a DAW mental model). */}
        <div className="mixer-section">
          <div className="mixer-header">
            <span className="mixer-label">MIXER</span>
            <span className="mixer-count">{peers.length} CH</span>
          </div>
          <div className="mixer-channels">
            {peers.map(p => {
              const pl = peerLevels[p.user_id] ?? 0
              return (
                <ChannelStrip
                  key={p.user_id}
                  peerId={p.user_id}
                  name={p.nickname || p.user_id.slice(0, 8)}
                  avatarUrl={p.avatar_url}
                  level={pl}
                  peak={pl > 0 ? pl * 1.1 : 0}
                  isSolo={soloId === p.user_id}
                  onSolo={(solo) => handleSolo(p.user_id, solo)}
                  onVolume={handleVolume}
                />
              )
            })}
            {peers.length === 0 && (
              <p className="empty-hint">等待其他乐手加入…</p>
            )}
          </div>
        </div>

        {/* INPUT TRACKS — the user's own mic input. Separate from MIXER
            so future per-input controls (gain, monitor, processing) can
            land here without competing with the peer-mix UI. */}
        <div className="mixer-section">
          <div className="mixer-header">
            <span className="mixer-label">INPUT TRACKS</span>
            <span className="mixer-count">1 CH</span>
          </div>
          <div className="mixer-channels">
            <ChannelStrip
              peerId={userId}
              name={userProfile?.nickname || 'YOU'}
              avatarUrl={userProfile?.avatarUrl}
              level={selfLevel}
              peak={selfPeak}
              isSelf
              isMuted={isMuted}
              isSolo={soloId === userId}
              onMute={(muted) => {
                if (muted) audioService.mute()
                else audioService.unmute()
                setIsMuted(muted)
              }}
              onSolo={(solo) => handleSolo(userId, solo)}
              onVolume={handleVolume}
            />
          </div>
        </div>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AudioDebugPanel />
    </div>
  )
}
