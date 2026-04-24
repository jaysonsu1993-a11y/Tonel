import { useState } from 'react'
import type { PeerInfo } from '../types'

interface Props {
  isLoggedIn: boolean
  onCreateRoom: (roomId: string, password?: string) => Promise<void>
  onJoinRoom: (roomId: string, password?: string) => Promise<void>
  onClearJoinError: () => void
  peers: PeerInfo[]
  joinError?: string | null
  createError?: string | null
}

export function HomePage({ isLoggedIn, onCreateRoom, onJoinRoom, onClearJoinError, peers, joinError, createError }: Props) {
  const [isJoining, setIsJoining] = useState(false)
  const [isCreating, setIsCreating] = useState(false)

  // 创建房间面板状态
  const [showCreatePanel, setShowCreatePanel] = useState(false)
  const [pendingRoomId, setPendingRoomId] = useState('')
  const [createPassword, setCreatePassword] = useState('')

  // 加入房间面板状态
  const [showJoinPanel, setShowJoinPanel] = useState(false)
  const [joinRoomId, setJoinRoomId] = useState('')
  const [joinPassword, setJoinPassword] = useState('')

  const handleCreateClick = () => {
    setPendingRoomId('')
    setCreatePassword('')
    setShowCreatePanel(true)
  }

  const handleCreateConfirm = async () => {
    // 留空则自动生成随机房间号（与 AppKit 逻辑一致）
    const id = pendingRoomId.trim().toUpperCase() || Math.random().toString(36).slice(2, 8).toUpperCase()
    setIsCreating(true)
    await onCreateRoom(id, createPassword || undefined)
    setIsCreating(false)
    setShowCreatePanel(false)
  }

  const handleCreateCancel = () => {
    setShowCreatePanel(false)
    setCreatePassword('')
  }

  const handleJoinClick = () => {
    setJoinRoomId('')
    setJoinPassword('')
    onClearJoinError()
    setShowJoinPanel(true)
  }

  const handleJoinConfirm = async () => {
    if (joinRoomId.trim().length < 1) return
    setIsJoining(true)
    await onJoinRoom(joinRoomId.trim().toUpperCase(), joinPassword || undefined)
    setIsJoining(false)
  }

  const handleJoinCancel = () => {
    setShowJoinPanel(false)
    setJoinRoomId('')
    setJoinPassword('')
    onClearJoinError()
  }

  return (
    <div className="home-page">
      {/* Hero */}
      <div className="hero">
        <h1 className="hero-title">Tonel 乐队排练平台</h1>
        <p className="hero-subtitle">实时音频协作，零延迟体验</p>
        <div className="user-badge">
          <span className="dot" />
          <span>{isLoggedIn ? 'PRO 用户' : '免费用户'}</span>
        </div>
      </div>

      {/* Action Grid */}
      <div className="action-grid">
        {/* 创建房间 */}
        {!showCreatePanel ? (
          <button className="action-card" onClick={handleCreateClick}>
            <h3>创建房间</h3>
            <p>发起新的排练会话</p>
          </button>
        ) : (
          <div className="action-card create-panel">
            <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px' }}>创建房间</h3>
            <input
              type="text"
              placeholder="自定义房间号（留空自动生成）"
              value={pendingRoomId}
              onChange={e => setPendingRoomId(e.target.value)}
              className="room-input"
              maxLength={20}
              autoFocus
            />
            <input
              type="password"
              placeholder="设置密码（可选）"
              value={createPassword}
              onChange={e => setCreatePassword(e.target.value)}
              className="room-input"
            />
            {createError && <p className="form-error">{createError}</p>}
            <div className="create-panel-actions">
              <button className="btn btn-primary" onClick={handleCreateConfirm} disabled={isCreating}>
                {isCreating ? '创建中…' : '创建'}
              </button>
              <button className="btn btn-ghost" onClick={handleCreateCancel} disabled={isCreating}>取消</button>
            </div>
          </div>
        )}

        {/* 加入房间 */}
        {!showJoinPanel ? (
          <button className="action-card" onClick={handleJoinClick}>
            <h3>加入房间</h3>
            <p>加入已有的排练会话</p>
          </button>
        ) : (
          <div className="action-card create-panel">
            <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px' }}>加入房间</h3>
            <input
              type="text"
              placeholder="输入房间号"
              value={joinRoomId}
              onChange={e => { setJoinRoomId(e.target.value.toUpperCase()); onClearJoinError() }}
              className="room-input"
              maxLength={8}
              autoFocus
            />
            <input
              type="password"
              placeholder="密码（如有）"
              value={joinPassword}
              onChange={e => { setJoinPassword(e.target.value); onClearJoinError() }}
              className="room-input"
            />
            {joinError && <p className="form-error">{joinError}</p>}
            <div className="create-panel-actions">
              <button className="btn btn-primary" onClick={handleJoinConfirm} disabled={isJoining || joinRoomId.trim().length < 1}>
                {isJoining ? '连接中…' : '加入'}
              </button>
              <button className="btn btn-ghost" onClick={handleJoinCancel} disabled={isJoining}>取消</button>
            </div>
          </div>
        )}
      </div>

      {/* Features */}
      <div className="features" id="features">
        <div className="feature">
          <span className="feature-dot" />
          <span>低延迟音频</span>
        </div>
        <div className="feature">
          <span className="feature-dot" />
          <span>多轨混音</span>
        </div>
        <div className="feature">
          <span className="feature-dot" />
          <span>跨平台支持</span>
        </div>
        <div className="feature">
          <span className="feature-dot" />
          <span>房间密码保护</span>
        </div>
      </div>

      {/* Online Peers */}
      {peers.length > 0 && (
        <div className="online-section">
          <div className="online-header">
            <span className="section-label">在线乐手</span>
            <span className="online-count">{peers.length} 人</span>
          </div>
          <div className="peer-list">
            {peers.map(p => (
              <div key={p.user_id} className="peer-chip">
                <span className="peer-dot" />
                <span>{p.user_id.slice(0, 12)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
