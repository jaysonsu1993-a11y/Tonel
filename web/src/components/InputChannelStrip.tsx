import { useEffect, useState } from 'react'
import { ChannelStrip } from './ChannelStrip'

interface Props {
  channelId:    string
  deviceId:     string
  deviceLabel:  string
  level:        number
  inputDevices: MediaDeviceInfo[]
  /** First channel can't be removed — there must always be one input. */
  canRemove:    boolean
  onDeviceChange: (deviceId: string) => void
  onMute:        (muted: boolean) => void
  onVolume:      (gain: number) => void
  onRemove?:     () => void
}

/**
 * Input-channel strip = a ChannelStrip + device selector + remove button
 * stacked above. The dropdown lets the user pick which OS audio input
 * feeds this channel. Click the × to remove the channel (and stop the
 * mic stream); first channel hides the × since the audio graph requires
 * at least one input.
 *
 * The strip behaves like any other ChannelStrip on the volume / mute /
 * solo / level meter axes — those wire through the parent's onMute /
 * onVolume callbacks. Solo isn't currently meaningful for inputs (no
 * "isolate one input" semantic on the send side), so it's left visual-
 * only via the ChannelStrip default.
 */
export function InputChannelStrip({
  channelId,
  deviceId,
  deviceLabel,
  level,
  inputDevices,
  canRemove,
  onDeviceChange,
  onMute,
  onVolume,
  onRemove,
}: Props) {
  const [muted, setMuted] = useState(false)
  // Keep local mute in sync if parent forces it (not currently used,
  // but matches the ChannelStrip pattern).
  useEffect(() => { /* noop */ }, [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      {/* Device selector — replaces the avatar at the top of the strip. */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <select
          value={deviceId}
          onChange={(e) => onDeviceChange(e.target.value)}
          style={{
            fontSize: 11, maxWidth: 110, padding: '2px 4px',
            background: '#222', color: '#ddd', border: '1px solid #555', borderRadius: 3,
          }}
          title={deviceLabel}
        >
          <option value="default">Default</option>
          {inputDevices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Input ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
        {canRemove && onRemove && (
          <button
            onClick={onRemove}
            title="移除该输入通道"
            style={{
              fontSize: 11, padding: '0 6px', cursor: 'pointer',
              background: '#3a1010', color: '#fdd', border: '1px solid #7a1a1a', borderRadius: 3,
            }}
          >
            ×
          </button>
        )}
      </div>
      <ChannelStrip
        peerId={channelId}
        name={deviceLabel.slice(0, 14)}
        level={level}
        peak={level > 0 ? level * 1.1 : 0}
        isSelf
        isMuted={muted}
        onMute={(m) => { setMuted(m); onMute(m) }}
        onVolume={onVolume}
      />
    </div>
  )
}
