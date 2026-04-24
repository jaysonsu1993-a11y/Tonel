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
  onVolume?: (volume: number) => void
}

export function ChannelStrip({
  peerId,
  name,
  level,
  peak,
  isSelf = false,
  isMuted = false,
  isSolo = false,
  onMute,
  onSolo,
  onVolume,
}: ChannelStripProps) {
  void peerId
  const [localMuted, setLocalMuted] = useState(isMuted)
  const [localSolo, setLocalSolo] = useState(isSolo)
  const [volume, setVolume] = useState(100) // 0-100

  useEffect(() => { setLocalMuted(isMuted) }, [isMuted])
  useEffect(() => { setLocalSolo(isSolo) }, [isSolo])

  const displayLevel = localMuted ? 0 : level
  const displayPeak = localMuted ? 0 : peak
  const dbValue = displayLevel > 0 ? Math.round(20 * Math.log10(displayLevel)) : -60

  const handleMute = () => {
    setLocalMuted(!localMuted)
    onMute?.(!localMuted)
  }

  const handleSolo = () => {
    setLocalSolo(!localSolo)
    onSolo?.(!localSolo)
  }

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value)
    setVolume(val)
    onVolume?.(val / 100)
  }

  return (
    <div className={`ch-strip ${isSelf ? 'ch-self' : ''}`}>
      {/* Channel name */}
      <div className="ch-name" title={name}>
        {name}
      </div>

      {/* Meter + Fader area */}
      <div className="ch-meter-fader">
        {/* LED Meter */}
        <div className="ch-meter">
          <LedMeter level={displayLevel} peak={displayPeak} segments={24} direction="vertical" />
        </div>

        {/* Vertical Fader */}
        <div className="ch-fader-wrap">
          <input
            type="range"
            className="ch-fader"
            min={0}
            max={100}
            value={volume}
            onChange={handleVolumeChange}
          />
        </div>
      </div>

      {/* dB readout */}
      <div className="ch-db">{dbValue > -60 ? `${dbValue}` : '-inf'} dB</div>

      {/* Mute / Solo buttons */}
      <div className="ch-buttons">
        <button
          className={`ch-btn ch-mute ${localMuted ? 'active' : ''}`}
          onClick={handleMute}
        >
          M
        </button>
        <button
          className={`ch-btn ch-solo ${localSolo ? 'active' : ''}`}
          onClick={handleSolo}
        >
          S
        </button>
      </div>
    </div>
  )
}
