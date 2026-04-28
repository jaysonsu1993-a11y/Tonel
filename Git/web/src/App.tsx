import { useState, useEffect, useCallback } from 'react'
import { HomePage } from './pages/HomePage'
import { RoomPage } from './pages/RoomPage'
import { useSignal } from './hooks/useSignal'
import { MusicBackground } from './components/MusicBackground'
import { WechatLogin } from './components/WechatLogin'
import type { PageState, UserProfile } from './types'
import './index.css'

// 生成免费用户 ID
// Stable guest userId across reloads. The mixer server tracks users by
// `roomId:userId`, so a fresh ID on every reload would leave a "ghost"
// entry in the room (the previous tab's userId) until the server cleans
// up the dead TCP connection — which breaks the solo-loopback fallback,
// makes peer lists flicker, and produces silence for the rejoined user.
// Persisting the guest ID keeps the session identity honest across
// tab reloads, page refreshes, and sample-rate changes.
const GUEST_ID_KEY = 'tonel_guest_id'
function generateGuestId(): string {
  const existing = localStorage.getItem(GUEST_ID_KEY)
  if (existing) return existing
  const fresh = `Guest_${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  localStorage.setItem(GUEST_ID_KEY, fresh)
  return fresh
}
function resetGuestId(): string {
  localStorage.removeItem(GUEST_ID_KEY)
  return generateGuestId()
}

// 用户服务 API 地址
const USER_API_BASE = import.meta.env.VITE_USER_API_URL || 'https://api.tonel.io'

export default function App() {
  const [page, setPage] = useState<PageState>('home')
  const [userId, setUserId] = useState('')
  const [roomId, setRoomId] = useState('')
  const [roomPassword, setRoomPassword] = useState<string | undefined>(undefined)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
  const [token, setToken] = useState(localStorage.getItem('tonel_token') || '')
  const { peers, connect, createRoom, joinRoom, leaveRoom } = useSignal()

  // 初始化：检查登录状态
  useEffect(() => {
    const guestId = generateGuestId()
    setUserId(guestId)
    connect()

    // 如果有 token，验证并获取用户信息
    if (token) {
      fetchUserProfile(token)
    }
  }, [])

  // 获取用户信息
  const fetchUserProfile = async (authToken: string) => {
    try {
      const res = await fetch(`${USER_API_BASE}/api/user/profile`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      })
      if (res.ok) {
        const data = await res.json()
        setUserProfile(data)
        setUserId(data.nickname || data.unionId)
        setIsLoggedIn(true)
      } else {
        // Token 无效，清除
        localStorage.removeItem('tonel_token')
        setToken('')
      }
    } catch (err) {
      console.error('Failed to fetch user profile:', err)
    }
  }

  // 处理微信登录成功
  const handleLoginSuccess = useCallback((newToken: string, profile: UserProfile) => {
    localStorage.setItem('tonel_token', newToken)
    setToken(newToken)
    setUserProfile(profile)
    setUserId(profile.nickname || profile.unionId)
    setIsLoggedIn(true)
    setShowLoginModal(false)
  }, [])

  // 退出登录
  const handleLogout = useCallback(() => {
    localStorage.removeItem('tonel_token')
    setToken('')
    setUserProfile(null)
    // Logout = identity reset: drop the persisted guest id and mint a new one,
    // so the post-logout session doesn't carry the same ghost entry into the
    // mixer's room state if the user had been talking before logging out.
    const guestId = resetGuestId()
    setUserId(guestId)
    setIsLoggedIn(false)
    if (roomId) {
      leaveRoom()
      setRoomId('')
      setPage('home')
    }
  }, [roomId, leaveRoom])

  const handleCreateRoom = useCallback(async (id: string, password?: string) => {
    setCreateError(null)
    try {
      await createRoom(id, userId, password)
      setRoomId(id)
      setRoomPassword(password)
      setPage('room')
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '创建房间失败')
    }
  }, [userId, createRoom])

  const handleJoinRoom = useCallback(async (id: string, password?: string) => {
    setJoinError(null)
    try {
      await joinRoom(id, userId, '0.0.0.0', 9003, password)
      setRoomId(id)
      setRoomPassword(password)
      setPage('room')
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : '加入房间失败')
    }
  }, [userId, joinRoom])

  const handleLeaveRoom = useCallback(() => {
    leaveRoom()
    setRoomId('')
    setRoomPassword(undefined)
    setPage('home')
  }, [leaveRoom])

  return (
    <div className="app-root">
      <MusicBackground />
      {/* 导航栏 */}
      <nav className="nav">
        <div className="nav-left">
          <a href="/" className="nav-brand">
            <span className="nav-name">Tonel</span>
          </a>
          <ul className="nav-links">
            <li><a href="#features">功能</a></li>
            <li><a href="https://github.com/jaysonsu1993-a11y/Tonel" target="_blank" rel="noopener">GitHub</a></li>
          </ul>
        </div>

        <div className="nav-right">
          <div className="user-badge">
            <span className="dot" />
            <span>{isLoggedIn ? (userProfile?.membershipType === 'pro' ? 'PRO' : 'BASIC') : 'FREE'}</span>
          </div>
          {isLoggedIn ? (
            <div className="user-info">
              {userProfile?.avatarUrl && (
                <img 
                  src={userProfile.avatarUrl} 
                  alt="avatar" 
                  className="user-avatar"
                  style={{ width: 28, height: 28, borderRadius: '50%', marginRight: 8 }}
                />
              )}
              <span className="user-nickname" style={{ marginRight: 12, fontSize: 14 }}>
                {userProfile?.nickname || userId}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={handleLogout}>
                退出
              </button>
            </div>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => setShowLoginModal(true)}>
              登录
            </button>
          )}
        </div>
      </nav>

      {/* 微信登录弹窗 */}
      {showLoginModal && (
        <WechatLogin 
          onSuccess={handleLoginSuccess}
          onClose={() => setShowLoginModal(false)}
        />
      )}

      {/* 页面内容 */}
      <main className="main-content">
        {page === 'home' && (
          <HomePage
            isLoggedIn={isLoggedIn}
            userProfile={userProfile}
            onCreateRoom={handleCreateRoom}
            onJoinRoom={handleJoinRoom}
            onClearJoinError={() => setJoinError(null)}
            peers={peers}
            joinError={joinError}
            createError={createError}
          />
        )}
        {page === 'room' && (
          <RoomPage
            roomId={roomId}
            userId={userId}
            userProfile={userProfile}
            password={roomPassword}
            peers={peers}
            onLeave={handleLeaveRoom}
          />
        )}
      </main>
    </div>
  )
}
