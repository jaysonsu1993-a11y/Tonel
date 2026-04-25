import { useState, useEffect, useRef } from 'react'
import type { UserProfile } from '../types'

interface Props {
  onSuccess: (token: string, profile: UserProfile) => void
  onClose: () => void
}

// 用户服务 API 地址
const USER_API_BASE = import.meta.env.VITE_USER_API_URL || 'https://api.tonel.io'
const WECHAT_APPID = import.meta.env.VITE_WECHAT_APPID || ''

export function WechatLogin({ onSuccess, onClose }: Props) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const checkIntervalRef = useRef<number | null>(null)

  // 方案 1：直接跳转微信 OAuth（PC 端扫码）
  const handleWechatLogin = () => {
    setIsLoading(true)
    setError('')

    // 构建微信 OAuth URL
    const redirectUri = encodeURIComponent(`${USER_API_BASE}/api/auth/wechat/callback`)
    const state = generateState()
    localStorage.setItem('wechat_state', state)

    const wechatUrl = `https://open.weixin.qq.com/connect/qrconnect?appid=${WECHAT_APPID}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`

    // 打开弹窗
    const width = 450
    const height = 500
    const left = (window.screen.width - width) / 2
    const top = (window.screen.height - height) / 2
    
    const popup = window.open(
      wechatUrl,
      'wechat_login',
      `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
    )

    if (!popup) {
      setError('弹窗被阻止，请允许弹窗后重试')
      setIsLoading(false)
      return
    }

    // 轮询检查弹窗是否返回结果
    checkIntervalRef.current = window.setInterval(() => {
      try {
        if (popup.closed) {
          // 弹窗关闭，检查 localStorage 是否有 token
          const token = localStorage.getItem('tonel_token')
          if (token) {
            // 获取用户信息
            fetchUserProfile(token)
          }
          clearCheckInterval()
          setIsLoading(false)
        }
      } catch (e) {
        // 跨域错误，忽略
      }
    }, 1000)
  }

  // 方案 2：内嵌二维码（需要微信 JS SDK）
  const handleEmbeddedQR = () => {
    setIsLoading(true)
    
    // 动态加载微信 JS SDK
    const script = document.createElement('script')
    script.src = 'https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js'
    script.onload = () => {
      // @ts-ignore
      if (window.WxLogin) {
        // @ts-ignore
        new window.WxLogin({
          self_redirect: false,
          id: 'wechat_qr_container',
          appid: WECHAT_APPID,
          scope: 'snsapi_login',
          redirect_uri: encodeURIComponent(`${USER_API_BASE}/api/auth/wechat/callback`),
          state: generateState(),
          style: '',
          href: ''
        })
      }
    }
    document.body.appendChild(script)
  }

  // 获取用户信息
  const fetchUserProfile = async (token: string) => {
    try {
      const res = await fetch(`${USER_API_BASE}/api/user/profile`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      if (res.ok) {
        const profile = await res.json()
        onSuccess(token, profile)
      }
    } catch (err) {
      setError('获取用户信息失败')
    }
  }

  const clearCheckInterval = () => {
    if (checkIntervalRef.current) {
      clearInterval(checkIntervalRef.current)
      checkIntervalRef.current = null
    }
  }

  useEffect(() => {
    return () => {
      clearCheckInterval()
    }
  }, [])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>微信登录</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {error && <div className="error-message">{error}</div>}

          <div className="login-options">
            {/* 方案 1：弹窗扫码 */}
            <button 
              className="btn btn-primary btn-large wechat-login-btn"
              onClick={handleWechatLogin}
              disabled={isLoading}
            >
              {isLoading ? '加载中...' : '微信扫码登录'}
            </button>

            <div className="divider">
              <span>或</span>
            </div>

            {/* 方案 2：内嵌二维码 */}
            <div id="wechat_qr_container" className="qr-container">
              <button 
                className="btn btn-ghost"
                onClick={handleEmbeddedQR}
                disabled={isLoading}
              >
                显示二维码
              </button>
            </div>
          </div>

          <p className="login-hint">
            登录后可保存个人设置，享受会员权益
          </p>
        </div>
      </div>
    </div>
  )
}

function generateState(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}
