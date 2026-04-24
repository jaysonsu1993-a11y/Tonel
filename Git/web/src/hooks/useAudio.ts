import { useState, useEffect, useRef, useCallback } from 'react'

export function useAudio() {
  const [level, setLevel] = useState(0)
  const [isMuted, setIsMuted] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)
  const rafRef = useRef<number | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)

  // 初始化音频（获取麦克风访问）
  const init = useCallback(async () => {
    if (isInitialized) return
    try {
      // 获取麦克风
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      })
      mediaStreamRef.current = stream

      // 创建 AudioContext 和 AnalyserNode
      const ctx = new AudioContext()
      audioContextRef.current = ctx
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.5
      analyserRef.current = analyser

      const source = ctx.createMediaStreamSource(stream)
      source.connect(analyser)

      setIsInitialized(true)

      // 开始采样电平
      const data = new Uint8Array(analyser.frequencyBinCount)
      const update = () => {
        if (analyser) {
          analyser.getByteFrequencyData(data)
          let sum = 0
          for (let i = 0; i < data.length; i++) {
            const v = data[i] / 255
            sum += v * v
          }
          const rms = Math.sqrt(sum / data.length)
          const normalizedLevel = Math.min(1, rms * 3) // 放大一些让它更明显
          setLevel(normalizedLevel)
        }
        rafRef.current = requestAnimationFrame(update)
      }
      update()
    } catch (err) {
      console.error('[useAudio] init failed:', err)
    }
  }, [isInitialized])

  // 进入房间时自动初始化
  useEffect(() => {
    init()
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(t => t.stop())
      }
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
    }
  }, [init])

  const toggleMute = useCallback(() => {
    if (mediaStreamRef.current) {
      const tracks = mediaStreamRef.current.getAudioTracks()
      tracks.forEach(t => { t.enabled = isMuted })
      setIsMuted(!isMuted)
    }
  }, [isMuted])

  return {
    level,
    isMuted,
    isInitialized,
    toggleMute,
  }
}
