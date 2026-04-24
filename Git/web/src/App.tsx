import { useState, useEffect, useCallback } from 'react'
import { HomePage } from './pages/HomePage'
import { RoomPage } from './pages/RoomPage'
import { useSignal } from './hooks/useSignal'
import { MusicBackground } from './components/MusicBackground'
import type { PageState } from './types'
import './index.css'

// 生成免费用户 ID
function generateGuestId(): string {
  return `Guest_${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

export default function App() {
  const [page, setPage] = useState<PageState>('home')
  const [userId, setUserId] = useState('')
  const [roomId, setRoomId] = useState('')
  const [roomPassword, setRoomPassword] = useState<string | undefined>(undefined)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const { peers, connect, createRoom, joinRoom, leaveRoom } = useSignal()

  // 默认免费用户模式
  useEffect(() => {
    const guestId = generateGuestId()
    setUserId(guestId)
    connect()
  }, [])

  const handleLogout = useCallback(() => {
    const guestId = generateGuestId()
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
      {/* 导航栏 - Hermes 风格 */}
      <nav className="nav">
        <div className="nav-left">
          <a href="/" className="nav-brand">
            <span className="nav-name">Tonel</span>
          </a>
          <ul className="nav-links">
            <li><a href="#features">功能</a></li>
            <li><a href="https://github.com/jaysonsu1993-a11y/S1-BandRehearsal" target="_blank" rel="noopener">GitHub</a></li>
          </ul>
        </div>

        <div className="nav-right">
          <div className="user-badge">
            <span className="dot" />
            <span>{isLoggedIn ? 'PRO' : 'FREE'}</span>
          </div>
          {isLoggedIn ? (
            <button className="btn btn-ghost btn-sm" onClick={handleLogout}>
              退出
            </button>
          ) : (
            <button className="btn btn-primary btn-sm">
              登录
            </button>
          )}
        </div>
      </nav>

      {/* 页面内容 */}
      <main className="main-content">
        {page === 'home' && (
          <HomePage
            isLoggedIn={isLoggedIn}
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
            password={roomPassword}
            peers={peers}
            onLeave={handleLeaveRoom}
          />
        )}
      </main>
    </div>
  )
}
