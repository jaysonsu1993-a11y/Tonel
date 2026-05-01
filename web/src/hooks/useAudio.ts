import { useState, useEffect, useCallback } from 'react'
import { audioService } from '../services/audioService'

/**
 * useAudio hook - 使用 audioService 单例，避免双重 AudioContext 冲突
 * P0-3 fix: 不再创建独立的 AudioContext，复用 audioService 的实例
 */
export function useAudio() {
  const [level, setLevel] = useState(0)
  const [isMuted, setIsMuted] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)

  // 使用 audioService 单例进行初始化
  const init = useCallback(async () => {
    if (isInitialized) return
    try {
      // 使用 audioService 初始化（它会创建 AudioContext 和 MediaStream）
      await audioService.init()
      setIsInitialized(true)

      // 订阅电平更新
      audioService.onLevel((lvl) => {
        setLevel(lvl)
      })
    } catch (err) {
      console.error('[useAudio] init failed:', err)
    }
  }, [isInitialized])

  // 组件挂载时初始化
  useEffect(() => {
    init()
    return () => {
      // 清理：只停止 capture，不销毁 audioService（它是单例）
      audioService.stopCapture()
    }
  }, [init])

  const toggleMute = useCallback(() => {
    if (isMuted) {
      audioService.unmute()
    } else {
      audioService.mute()
    }
    setIsMuted(!isMuted)
  }, [isMuted])

  return {
    level,
    isMuted,
    isInitialized,
    toggleMute,
  }
}
