import { useMemo } from 'react'

interface LedMeterProps {
  level: number  // 0-1
  peak?: number  // 0-1
  segments?: number
  direction?: 'vertical' | 'horizontal'
}

export function LedMeter({ level, peak = 0, segments = 20, direction = 'vertical' }: LedMeterProps) {
  // Map linear RMS (0-1) to dB-scaled meter position for visibility
  // -48dB → 0 segments, 0dB → full scale (matches pro audio meter behavior)
  const dbRange = 48
  const toMeterPos = (v: number) => {
    if (v <= 0) return 0
    const db = 20 * Math.log10(v)
    return Math.max(0, Math.min(1, (db + dbRange) / dbRange))
  }
  const activeSegments = Math.round(toMeterPos(level) * segments)
  const peakSegment = Math.round(toMeterPos(peak) * segments)

  const getSegmentColor = (idx: number) => {
    const ratio = idx / segments
    if (ratio >= 0.85) return 'red'
    if (ratio >= 0.65) return 'yellow'
    return 'green'
  }

  const segs = useMemo(() => {
    return Array.from({ length: segments }, (_, i) => {
      const segIdx = direction === 'vertical' ? segments - 1 - i : i
      const isActive = segIdx < activeSegments
      const isPeak = segIdx === peakSegment - 1 && peak > 0
      const color = getSegmentColor(segIdx)
      return { segIdx, isActive, isPeak, color }
    })
  }, [activeSegments, peakSegment, segments, direction])

  if (direction === 'horizontal') {
    return (
      <div className="led-meter" style={{ flexDirection: 'row', gap: '2px' }}>
        {segs.map(({ segIdx, isActive, isPeak, color }) => (
          <div
            key={segIdx}
            className={`led-segment ${isActive || isPeak ? `active ${color}` : ''}`}
            style={{ width: '4px', height: '12px' }}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="led-meter" style={{ flexDirection: 'column', gap: '1px' }}>
      {segs.map(({ segIdx, isActive, isPeak, color }) => (
        <div
          key={segIdx}
          className={`led-segment ${isActive || isPeak ? `active ${color}` : ''}`}
          style={{ width: '100%', height: '3px' }}
        />
      ))}
    </div>
  )
}
