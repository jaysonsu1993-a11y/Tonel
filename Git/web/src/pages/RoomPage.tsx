import { useEffect, useRef, useState } from 'react'
import { audioService } from '../services/audioService'
import type { PeerInfo } from '../types'
import { ChannelStrip } from '../components/ChannelStrip'
import { LedMeter } from '../components/LedMeter'

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
  const dbm = selfLevel > 0 ? Math.round(20 * Math.log10(selfLevel) + 60) : -60

  return (
    <div className="room-page">
      <header className="room-header">
        <div className="room-info">
          <div>
            <div className="room-label">房间号</div>
            <div className="room-id">{roomId}</div>
          </div>
          <button className="btn-copy" onClick={copyRoomId}>
            {copied ? '✓ 已复制' : '复制'}
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
                {d.label || `麦克风 ${d.deviceId.slice(0, 8)}`}
              </option>
            ))}
          </select>
        </div>

        <button className="btn-leave" onClick={onLeave}>离开房间</button>
      </header>

      <div className="room-content">
        {/* 自己的麦克风 */}
        <div className="mic-panel self">
          <button
            className={`mic-btn ${isMuted ? 'muted' : ''}`}
            onClick={toggleMute}
          >
            {isMuted ? '🔇' : '🎤'}
            <span>{isMuted ? '已静音' : '正在录音'}</span>
          </button>
          <div className="meter-section">
            <div className="meter-label">输入电平</div>
            <div className="meter-bar-wrap">
              <div
                className={`meter-bar ${isMuted ? 'muted' : ''}`}
                style={{ width: `${Math.min(100, selfLevel * 100)}%` }}
              />
            </div>
            <div className="meter-dbm">{dbm} dB</div>
          </div>
          <LedMeter level={selfLevel} peak={selfPeak} segments={16} direction="vertical" />
        </div>

        {/* 参与者 */}
        <div className="participants-section">
          <div className="participants-header">
            <div className="participants-label">乐手</div>
            <div className="participants-count">{peers.length + 1} 人</div>
          </div>
          <div className="participants-grid">
            <ChannelStrip
              peerId={userId}
              name="你"
              level={selfLevel}
              peak={selfPeak}
              isSelf
              isMuted={isMuted}
            />
            {peers.map(p => (
              <ChannelStrip
                key={p.user_id}
                peerId={p.user_id}
                name={p.user_id.slice(0, 8)}
                addr={`${p.ip}:${p.port}`}
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
