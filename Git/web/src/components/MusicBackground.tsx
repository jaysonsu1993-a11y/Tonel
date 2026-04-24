import { useEffect, useRef } from 'react'

/**
 * MusicBackground - 乐器动画背景
 * 使用 Canvas 绘制浮动的乐器元素（键盘、合成器、麦克风）
 */

interface Instrument {
  type: 'keyboard' | 'synth' | 'mic'
  x: number
  y: number
  size: number
  rotation: number
  speedX: number
  speedY: number
  rotationSpeed: number
  opacity: number
  pulsePhase: number
}

export function MusicBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animationId: number
    let instruments: Instrument[] = []

    const resize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }

    const createInstrument = (type: Instrument['type']): Instrument => ({
      type,
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      size: 40 + Math.random() * 60,
      rotation: Math.random() * Math.PI * 2,
      speedX: (Math.random() - 0.5) * 0.3,
      speedY: (Math.random() - 0.5) * 0.3,
      rotationSpeed: (Math.random() - 0.5) * 0.01,
      opacity: 0.03 + Math.random() * 0.05,
      pulsePhase: Math.random() * Math.PI * 2,
    })

    const initInstruments = () => {
      instruments = []
      // 键盘
      for (let i = 0; i < 4; i++) {
        instruments.push(createInstrument('keyboard'))
      }
      // 合成器
      for (let i = 0; i < 4; i++) {
        instruments.push(createInstrument('synth'))
      }
      // 麦克风
      for (let i = 0; i < 3; i++) {
        instruments.push(createInstrument('mic'))
      }
    }

    const drawKeyboard = (inst: Instrument) => {
      ctx.save()
      ctx.translate(inst.x, inst.y)
      ctx.rotate(inst.rotation)
      ctx.globalAlpha = inst.opacity

      const w = inst.size * 1.5
      const h = inst.size * 0.4

      // 键盘主体
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.strokeRect(-w/2, -h/2, w, h)

      // 琴键
      const keyCount = 7
      const keyWidth = w / keyCount
      for (let i = 0; i < keyCount; i++) {
        ctx.strokeRect(-w/2 + i * keyWidth, -h/2, keyWidth, h)
      }

      ctx.restore()
    }

    const drawSynth = (inst: Instrument) => {
      ctx.save()
      ctx.translate(inst.x, inst.y)
      ctx.rotate(inst.rotation)
      ctx.globalAlpha = inst.opacity

      const w = inst.size
      const h = inst.size * 0.8

      // 合成器主体
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.strokeRect(-w/2, -h/2, w, h)

      // 旋钮区域
      const knobRows = 2
      const knobCols = 3
      const knobSize = w / 8
      for (let row = 0; row < knobRows; row++) {
        for (let col = 0; col < knobCols; col++) {
          const kx = -w/3 + col * (w/3)
          const ky = -h/3 + row * (h/2.5)
          ctx.beginPath()
          ctx.arc(kx, ky, knobSize/2, 0, Math.PI * 2)
          ctx.stroke()
          // 旋钮指示线
          ctx.beginPath()
          ctx.moveTo(kx, ky)
          ctx.lineTo(kx + knobSize/2 * Math.cos(inst.rotation * 2), ky + knobSize/2 * Math.sin(inst.rotation * 2))
          ctx.stroke()
        }
      }

      // 推子
      for (let i = 0; i < 4; i++) {
        const fx = -w/2 + w/5 + i * (w/5)
        ctx.beginPath()
        ctx.moveTo(fx, h/4)
        ctx.lineTo(fx, h/2.5)
        ctx.stroke()
        // 推子滑块
        const sliderPos = Math.sin(inst.pulsePhase + i) * 0.3 + 0.5
        ctx.fillRect(fx - 3, h/4 + sliderPos * (h/2.5 - h/4) - 3, 6, 6)
      }

      ctx.restore()
    }

    const drawMic = (inst: Instrument) => {
      ctx.save()
      ctx.translate(inst.x, inst.y)
      ctx.rotate(inst.rotation)
      ctx.globalAlpha = inst.opacity

      const headSize = inst.size * 0.35
      const bodyHeight = inst.size * 0.6

      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5

      // 麦克风头部（圆形网罩）
      ctx.beginPath()
      ctx.arc(0, -bodyHeight/3, headSize, 0, Math.PI * 2)
      ctx.stroke()

      // 网罩纹理
      for (let i = 0; i < 3; i++) {
        ctx.beginPath()
        ctx.arc(0, -bodyHeight/3, headSize * (0.3 + i * 0.25), 0, Math.PI * 2)
        ctx.stroke()
      }

      // 麦克风身体
      ctx.beginPath()
      ctx.moveTo(-headSize * 0.6, -bodyHeight/3 + headSize * 0.3)
      ctx.lineTo(-headSize * 0.4, bodyHeight/2)
      ctx.lineTo(headSize * 0.4, bodyHeight/2)
      ctx.lineTo(headSize * 0.6, -bodyHeight/3 + headSize * 0.3)
      ctx.closePath()
      ctx.stroke()

      // 开关
      ctx.fillRect(-4, 0, 8, 12)

      ctx.restore()
    }

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      instruments.forEach(inst => {
        // 更新位置
        inst.x += inst.speedX
        inst.y += inst.speedY
        inst.rotation += inst.rotationSpeed
        inst.pulsePhase += 0.02

        // 边界回弹
        if (inst.x < -100) inst.x = canvas.width + 100
        if (inst.x > canvas.width + 100) inst.x = -100
        if (inst.y < -100) inst.y = canvas.height + 100
        if (inst.y > canvas.height + 100) inst.y = -100

        // 绘制
        switch (inst.type) {
          case 'keyboard':
            drawKeyboard(inst)
            break
          case 'synth':
            drawSynth(inst)
            break
          case 'mic':
            drawMic(inst)
            break
        }
      })

      animationId = requestAnimationFrame(animate)
    }

    resize()
    initInstruments()
    animate()

    window.addEventListener('resize', resize)

    return () => {
      cancelAnimationFrame(animationId)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="music-background"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  )
}
