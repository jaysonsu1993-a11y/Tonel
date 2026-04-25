import { useState, useEffect, useRef, useCallback } from 'react'
import { LedMeter } from './LedMeter'

const DB_SCALE_MARKS = [0, -6, -12, -18, -24, -36, -48] as const

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

  // volume(0-100) → dB, dB → volume helpers
  const volToDb = (v: number) => v <= 0 ? -Infinity : 20 * Math.log10(v / 100)
  const dbToVol = (db: number) => Math.round(Math.pow(10, db / 20) * 100)

  const faderRef = useRef<HTMLDivElement>(null)

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const step = e.shiftKey ? 0.1 : 1  // Shift = fine mode
    const direction = e.deltaY < 0 ? 1 : -1  // scroll up = louder
    const currentDb = volToDb(volume)
    const newDb = Math.min(0, Math.max(-60, currentDb + direction * step))
    const newVol = newDb <= -60 ? 0 : Math.min(100, Math.max(0, dbToVol(newDb)))
    setVolume(newVol)
    onVolume?.(newVol / 100)
  }, [volume, onVolume])

  useEffect(() => {
    const el = faderRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  return (
    <div className={`ch-strip ${isSelf ? 'ch-self' : ''}`}>
      {/* Channel name */}
      <div className="ch-name" title={name}>
        {name}
      </div>

      {/* Meter + Fader area */}
      <div className="ch-meter-fader">
        {/* dB scale */}
        <div className="ch-db-scale">
          {DB_SCALE_MARKS.map(db => (
            <span
              key={db}
              className={`ch-db-mark${db >= -3 ? ' clip' : ''}`}
              style={{ top: `${((0 - db) / 48) * 100}%` }}
            >
              {db}
            </span>
          ))}
        </div>

        {/* LED Meter */}
        <div className="ch-meter">
          <LedMeter level={displayLevel} peak={displayPeak} segments={24} direction="vertical" />
        </div>

        {/* Vertical Fader */}
        <div className="ch-fader-wrap" ref={faderRef}>
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

      {/* Fader dB readout */}
      <div className="ch-db">{volume > 0 ? `${Math.round(volToDb(volume))}` : '-inf'} dB</div>

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
