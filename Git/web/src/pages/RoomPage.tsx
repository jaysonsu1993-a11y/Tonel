import { useEffect, useRef, useState } from 'react'
import { audioService } from '../services/audioService'
import { signalService } from '../services/signalService'
import type { PeerInfo } from '../types'
import { ChannelStrip } from '../components/ChannelStrip'

interface Props {
  roomId: string
  userId: string
  password?: string
  peers: PeerInfo[]
  onLeave: () => void
}

export function RoomPage({ roomId, userId, peers, onLeave }: Props) {
  const [selfLevel, setSelfLevel] = useState(0)
  const [isMuted, setIsMuted] = useState(false)
  const [copied, setCopied] = useState(false)
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDevice, setSelectedDevice] = useState<string>('')
  const [latency, setLatency] = useState<number>(-1)
  const joinedRef = useRef(false)

  // Load available audio input devices
  useEffect(() => {
    audioService.getAudioInputDevices().then(devs => {
      setInputDevices(devs)
      if (devs.length > 0 && !selectedDevice) {
        setSelectedDevice(devs[0].deviceId)
      }
    })
  }, [])

  // Subscribe to latency updates
  useEffect(() => {
    const unsub = signalService.onLatency((ms) => setLatency(ms))
    return unsub
  }, [])

  useEffect(() => {
    if (joinedRef.current) return
    joinedRef.current = true

    // 初始化音频并连接混音服务器
    ;(async () => {
      try {
        await audioService.init()
        audioService.onLevel((l) => setSelfLevel(l))
        await audioService.connectMixer(userId, roomId)
        await audioService.startCapture()
      } catch (err) {
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

  const handleDeviceChange = async (deviceId: string) => {
    setSelectedDevice(deviceId)
    try {
      await audioService.setInputDevice(deviceId)
    } catch (err) {
      console.error('[RoomPage] Failed to switch device:', err)
    }
  }

  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

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

        {/* 音频输入设备选择 */}
        <div className="device-selector">
          <select
            value={selectedDevice}
            onChange={e => handleDeviceChange(e.target.value)}
            className="device-select"
          >
            {inputDevices.map(d => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Input ${d.deviceId.slice(0, 8)}`}
              </option>
            ))}
          </select>
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
              name="YOU"
              level={selfLevel}
              peak={selfPeak}
              isSelf
              isMuted={isMuted}
              onMute={(muted) => {
                if (muted) audioService.mute()
                else audioService.unmute()
                setIsMuted(muted)
              }}
            />
            {peers.map(p => (
              <ChannelStrip
                key={p.user_id}
                peerId={p.user_id}
                name={p.user_id.slice(0, 8)}
                level={0}
                peak={0}
              />
            ))}
            {peers.length === 0 && (
              <p className="empty-hint">等待其他乐手加入…</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
