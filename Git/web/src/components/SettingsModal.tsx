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
  const [inputDevices,  setInputDevices]  = useState<MediaDeviceInfo[]>([])
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedInput,  setSelectedInput]  = useState<string>('')
  const [selectedOutput, setSelectedOutput] = useState<string>('')
  const [requestedRate,  setRequestedRate]  = useState<number | null>(AudioService.readUserRate())
  const [actualRate,     setActualRate]     = useState<number>(audioService.actualSampleRate)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      const inputs  = await audioService.getAudioInputDevices()
      const outputs = await audioService.getAudioOutputDevices()
      if (cancelled) return
      setInputDevices(inputs)
      setOutputDevices(outputs)
      // Reflect actual current selection by querying audioService where possible.
      if (!selectedInput  && inputs.length > 0)  setSelectedInput(inputs[0].deviceId)
      if (!selectedOutput && outputs.length > 0) setSelectedOutput(outputs[0].deviceId)
      setActualRate(audioService.actualSampleRate)
    })()
    return () => { cancelled = true }
  }, [open])

  if (!open) return null

  const handleInputChange = async (deviceId: string) => {
    setSelectedInput(deviceId)
    try { await audioService.setInputDevice(deviceId) }
    catch (err) { console.error('[Settings] input switch failed:', err) }
  }
  const handleOutputChange = async (deviceId: string) => {
    setSelectedOutput(deviceId)
    try { await audioService.setOutputDevice(deviceId) }
    catch (err) { console.error('[Settings] output switch failed:', err) }
  }

  const handleRateChange = (raw: string) => {
    const value = raw === 'auto' ? null : Number(raw)
    setRequestedRate(value)
    AudioService.writeUserRate(value)
    // Reload so the new rate is applied to a fresh AudioContext +
    // getUserMedia stream. In-place reconfig would be cleaner UX but
    // requires tearing down and re-establishing every audio node;
    // the user only changes this rarely, so a reload is fine.
    setTimeout(() => window.location.reload(), 50)
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
          <div className="settings-row">
            <label>输入</label>
            <select value={selectedInput} onChange={e => handleInputChange(e.target.value)}>
              {inputDevices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Input ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
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
