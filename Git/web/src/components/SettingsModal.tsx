import { useEffect, useState } from 'react'
import { audioService, AudioService } from '../services/audioService'

// Settings modal — device selection + sample-rate override.
//
// Sample-rate selection is both a feature (let advanced users force a
// rate they know their hardware likes) and a diagnostic: since the
// wire/server is fixed at 48 kHz, picking 48 kHz here bypasses the
// capture-side and worklet-side resamplers entirely, which is the
// quickest way to A/B-test "is the residual distortion coming from
// the linear-interpolation resamplers?". Picking 44.1 kHz forces
// resampling on; the user can compare the two side-by-side.
//
// Selecting a rate persists in localStorage and triggers a page reload
// so AudioContext / getUserMedia restart cleanly with the new rate.

interface Props {
  open:  boolean
  onClose: () => void
}

export function SettingsModal({ open, onClose }: Props) {
  // v3.6.0: input device selection moved to per-channel dropdowns in
  // INPUT TRACKS, so the settings modal only carries output device +
  // sample-rate from now on.
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedOutput, setSelectedOutput] = useState<string>('')
  const [requestedRate,  setRequestedRate]  = useState<number | null>(AudioService.readUserRate())
  const [actualRate,     setActualRate]     = useState<number>(audioService.actualSampleRate)
  // v3.7.2: speaker-mode workaround for iOS earpiece routing.
  // v3.7.3: only surface this control on iOS — on desktop the
  // browser's normal AudioContext.destination → setSinkId path is
  // already exposed via the output-device dropdown, and a redundant
  // "speaker" toggle here just confused the desktop UX.
  const [speakerMode, setSpeakerMode] = useState<boolean>(AudioService.readSpeakerMode())
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ identifies as Mac with touch; treat as iOS for the
    // earpiece-routing workaround since the audio session category
    // gating is the same.
    (navigator.platform === 'MacIntel' && (navigator as { maxTouchPoints?: number }).maxTouchPoints! > 1)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      const outputs = await audioService.getAudioOutputDevices()
      if (cancelled) return
      setOutputDevices(outputs)
      if (!selectedOutput && outputs.length > 0) setSelectedOutput(outputs[0].deviceId)
      setActualRate(audioService.actualSampleRate)
    })()
    return () => { cancelled = true }
  }, [open])

  if (!open) return null

  const handleOutputChange = async (deviceId: string) => {
    setSelectedOutput(deviceId)
    try { await audioService.setOutputDevice(deviceId) }
    catch (err) { console.error('[Settings] output switch failed:', err) }
  }

  const handleRateChange = async (raw: string) => {
    const value = raw === 'auto' ? null : Number(raw)
    setRequestedRate(value)
    try {
      // In-place rebuild — does NOT reload the page, so the user
      // stays in their room and keeps the same userId on the server.
      // (A reload would regenerate the guest userId, leaving a ghost
      // entry in the room and breaking the solo-mix fallback.)
      await audioService.changeSampleRate(value)
      setActualRate(audioService.actualSampleRate)
    } catch (err) {
      console.error('[Settings] sample-rate change failed:', err)
    }
  }

  const rateOptions: Array<{ label: string; value: 'auto' | number }> = [
    { label: '自动 (浏览器默认)', value: 'auto' },
    ...AudioService.SUPPORTED_RATES.map(r => ({
      label: `${r} Hz${r === 48000 ? ' (匹配传输速率)' : ''}`,
      value: r,
    })),
  ]

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <header className="settings-header">
          <h2>设置</h2>
          <button className="settings-close" onClick={onClose} aria-label="关闭">×</button>
        </header>

        <section className="settings-section">
          <h3>音频设备</h3>
          <div className="settings-hint subtle">
            输入设备已移至 INPUT TRACKS 内的每个通道条 — 每个输入通道可独立选择麦克风。
          </div>
          <div className="settings-row">
            <label>输出</label>
            <select value={selectedOutput} onChange={e => handleOutputChange(e.target.value)}>
              {outputDevices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Output ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
          {/* Speaker-mode toggle — iOS only.
              v3.7.3: hidden on desktop because the output-device
              dropdown above already does the right thing via
              `setSinkId`. Surfacing both controls confused desktop
              users (the toggle looked like the desktop dropdown was
              still mobile-flavoured). */}
          {isIOS && (
            <>
              <div className="settings-row">
                <label>扬声器</label>
                <button
                  onClick={async () => {
                    const next = !speakerMode
                    setSpeakerMode(next)
                    try { await audioService.setSpeakerMode(next) }
                    catch (err) { console.error('[Settings] setSpeakerMode failed:', err) }
                  }}
                  style={{
                    padding: '6px 12px', borderRadius: 6,
                    background: speakerMode ? '#fff' : 'transparent',
                    color:      speakerMode ? '#000' : '#888',
                    border: '1px solid #333',
                    cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
                  }}
                >
                  {speakerMode ? '扬声器（已启用）' : '扬声器（关闭，走听筒）'}
                </button>
              </div>
              <div className="settings-hint subtle">
                iPhone 默认通过听筒输出（mic 一开就走 PlayAndRecord 通道）。
                打开此项可强制走扬声器。
              </div>
            </>
          )}
        </section>

        <section className="settings-section">
          <h3>采样率</h3>
          <div className="settings-row">
            <label>请求</label>
            <select
              value={requestedRate === null ? 'auto' : String(requestedRate)}
              onChange={e => handleRateChange(e.target.value)}
            >
              {rateOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="settings-hint">
            实际：{actualRate ? `${actualRate} Hz` : '未连接'}
            {actualRate === 48000 && ' — 与传输速率匹配，无重采样'}
            {actualRate !== 0 && actualRate !== 48000 && ' — 链路两端会做线性重采样'}
          </div>
          <div className="settings-hint subtle">
            选择 48000 Hz 可绕过采集 / 播放两侧的重采样器，便于排查与采样率相关的失真。修改后页面会刷新。
          </div>
        </section>
      </div>
    </div>
  )
}
