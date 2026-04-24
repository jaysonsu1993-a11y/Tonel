import React, { useState } from 'react'

interface Props {
  onLogin: (userId: string, phone: string, wechat: string) => void
}

export function LoginPage({ onLogin }: Props) {
  const [phone, setPhone] = useState('')
  const [wechat, setWechat] = useState('')
  const [activeTab, setActiveTab] = useState<'phone' | 'wechat'>('phone')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (activeTab === 'phone' && !phone.trim()) return
    if (activeTab === 'wechat' && !wechat.trim()) return

    // 生成临时 userId
    const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    onLogin(userId, activeTab === 'phone' ? phone : '', activeTab === 'wechat' ? wechat : '')
  }

  return (
    <div className="page login-page">
      <div className="logo-area">
        <div className="logo-icon">🎸</div>
        <h1 className="app-title">乐队排练平台</h1>
        <p className="app-subtitle">S1 · 实时乐队排练</p>
      </div>

      <div className="login-card">
        <div className="tab-bar">
          <button
            className={`tab-btn ${activeTab === 'phone' ? 'active' : ''}`}
            onClick={() => setActiveTab('phone')}
          >
            手机号登录
          </button>
          <button
            className={`tab-btn ${activeTab === 'wechat' ? 'active' : ''}`}
            onClick={() => setActiveTab('wechat')}
          >
            微信登录
          </button>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          {activeTab === 'phone' ? (
            <div className="input-group">
              <input
                type="tel"
                placeholder="请输入手机号"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                className="input"
                maxLength={11}
              />
            </div>
          ) : (
            <div className="input-group">
              <input
                type="text"
                placeholder="请输入微信号"
                value={wechat}
                onChange={e => setWechat(e.target.value)}
                className="input"
              />
            </div>
          )}

          <button type="submit" className="btn-primary">
            进入排练室
          </button>
        </form>

        <p className="login-tip">
          登录即表示同意<a href="#">《用户协议》</a>
        </p>
      </div>
    </div>
  )
}
