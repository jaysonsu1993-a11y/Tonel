interface LedMeterProps {
  level: number  // 0-1 linear RMS
  peak?: number  // 0-1
  direction?: 'vertical' | 'horizontal'
}

// dB-scaled meter: -60dB → 0%, 0dB → 100%
function toDb(v: number): number {
  if (v <= 0) return 0
  const db = 20 * Math.log10(v)
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

export function LedMeter({ level, direction = 'vertical' }: LedMeterProps) {
  const pct = toDb(level) * 100

  if (direction === 'horizontal') {
    return (
      <div className="led-bar" style={{ width: '100%', height: 12 }}>
        <div className="led-fill" style={{ width: `${pct}%`, height: '100%' }} />
      </div>
    )
  }

  return (
    <div className="led-bar led-bar-v">
      <div className="led-fill" style={{ height: `${pct}%` }} />
    </div>
  )
}
