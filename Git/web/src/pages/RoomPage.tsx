import { useEffect, useRef, useState, useCallback } from 'react'
import { audioService } from '../services/audioService'
import type { PeerInfo } from '../types'
import { ChannelStrip } from '../components/ChannelStrip'

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
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([])
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedInput, setSelectedInput] = useState<string>('')
  const [selectedOutput, setSelectedOutput] = useState<string>('')
  const [latency, setLatency] = useState<number>(-1)
  const [audioDebug, setAudioDebug] = useState<string>('')
  const joinedRef = useRef(false)

  // Load available audio devices AFTER init (needs permission for labels)
  const refreshDevices = useCallback(async () => {
    const inputs = await audioService.getAudioInputDevices()
    setInputDevices(inputs)
    if (inputs.length > 0 && !selectedInput) setSelectedInput(inputs[0].deviceId)
    const outputs = await audioService.getAudioOutputDevices()
    setOutputDevices(outputs)
    if (outputs.length > 0 && !selectedOutput) setSelectedOutput(outputs[0].deviceId)
  }, [selectedInput, selectedOutput])

  // Subscribe to audio latency updates (via WebRTC DataChannel, not signaling)
  useEffect(() => {
    const unsub = audioService.onLatency((ms) => setLatency(ms))
    return unsub
  }, [])

  useEffect(() => {
    if (joinedRef.current) return
    joinedRef.current = true

    // 初始化音频并连接混音服务器
    ;(async () => {
      try {
        setAudioDebug('init...')
        await audioService.init()
        refreshDevices()  // enumerate devices after mic permission granted
        audioService.onLevel((l) => setSelfLevel(l))
        audioService.onPeerLevel((uid, level) => {
          setPeerLevels(prev => ({ ...prev, [uid]: level }))
        })
        setAudioDebug('connecting mixer...')
        await audioService.connectMixer(userId, roomId)
        setAudioDebug('starting capture...')
        audioService.startCapture()
        // Wait for worklet to load, then show final state
        setTimeout(() => {
          setAudioDebug(`FINAL: ${audioService.debugState()} | lvl=${audioService.currentLevel.toFixed(3)}`)
        }, 2000)
        // Keep updating level in debug every 2s
        setInterval(() => {
          setAudioDebug(`${audioService.debugState()} | lvl=${audioService.currentLevel.toFixed(3)}`)
        }, 2000)
      } catch (err) {
        setAudioDebug(`ERROR: ${err}`)
        console.error('[RoomPage] Audio init failed:', err)
      }
    })()

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

  const handleInputChange = async (deviceId: string) => {
    setSelectedInput(deviceId)
    try {
      await audioService.setInputDevice(deviceId)
    } catch (err) {
      console.error('[RoomPage] Failed to switch input device:', err)
    }
  }

  const handleOutputChange = async (deviceId: string) => {
    setSelectedOutput(deviceId)
    try {
      await audioService.setOutputDevice(deviceId)
    } catch (err) {
      console.error('[RoomPage] Failed to switch output device:', err)
    }
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

  return (
    <div className="room-page">
      <header className="room-header">
        <div className="room-info">
          <div>
            <div className="room-label">房间号</div>
            <div className="room-id">{roomId}</div>
          </div>
          <button className="btn-copy" onClick={copyRoomId}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>

        {/* 音频设备选择 */}
        <div className="device-selector">
          <div className="device-row">
            <label className="device-label">输入</label>
            <select
              value={selectedInput || undefined}
              onChange={e => handleInputChange(e.target.value)}
              className="device-select"
            >
              {inputDevices.length === 0 && <option value="">--</option>}
              {inputDevices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Input ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
          <div className="device-row">
            <label className="device-label">输出</label>
            <select
              value={selectedOutput || undefined}
              onChange={e => handleOutputChange(e.target.value)}
              className="device-select"
            >
              {outputDevices.length === 0 && <option value="">--</option>}
              {outputDevices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Output ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
        </div>

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
        {audioDebug && <div style={{fontSize:'10px',color:'#888',position:'absolute',bottom:2,left:8}}>{audioDebug}</div>}
      </header>

      <div className="room-content">
        {/* 调音台区域 */}
        <div className="mixer-section">
          <div className="mixer-header">
            <span className="mixer-label">MIXER</span>
            <span className="mixer-count">{peers.length + 1} CH</span>
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
      </div>
    </div>
  )
}
