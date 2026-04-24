import { useState, useEffect } from 'react'
import { LedMeter } from './LedMeter'

interface ChannelStripProps {
  peerId: string
  name: string
  addr?: string
  level: number      // 0-1
  peak: number       // 0-1
  isSelf?: boolean
  isMuted?: boolean
  isSolo?: boolean
  onMute?: (muted: boolean) => void
  onSolo?: (solo: boolean) => void
}

export function ChannelStrip({
  peerId,
  name,
  addr,
  level,
  peak,
  isSelf = false,
  isMuted = false,
  isSolo = false,
  onMute,
  onSolo,
}: ChannelStripProps) {
  // peerId kept for future use (WebRTC data channel routing)
  void peerId
  const [localMuted, setLocalMuted] = useState(isMuted)
  const [localSolo, setLocalSolo] = useState(isSolo)

  useEffect(() => { setLocalMuted(isMuted) }, [isMuted])
  useEffect(() => { setLocalSolo(isSolo) }, [isSolo])

  const displayLevel = localMuted ? 0 : level
  const displayPeak = localMuted ? 0 : peak

  const handleMute = () => {
    setLocalMuted(!localMuted)
    onMute?.(!localMuted)
  }

  const handleSolo = () => {
    setLocalSolo(!localSolo)
    onSolo?.(!localSolo)
  }

  const avatarEmoji = isSelf ? '🎤' : '🎸'

  return (
    <div className={`participant-card ${isSelf ? 'self' : ''}`}>
      <div className="p-avatar">{avatarEmoji}</div>
      <div className="p-info">
        <div className="p-name">{name}</div>
        {addr && <div className="p-addr">{addr}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
        <LedMeter level={displayLevel} peak={displayPeak} segments={16} direction="vertical" />
        <div className="p-controls">
          <button
            className={`btn-mute ${localMuted ? 'active' : ''}`}
            onClick={handleMute}
            title="Mute"
          >
            M
          </button>
          <button
            className={`btn-solo ${localSolo ? 'active' : ''}`}
            onClick={handleSolo}
            title="Solo"
          >
            S
          </button>
        </div>
      </div>
    </div>
  )
}
