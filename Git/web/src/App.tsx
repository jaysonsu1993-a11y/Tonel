import { useState, useEffect, useCallback, useRef } from 'react'
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

// Per-device suffix for logged-in userIds. Two devices signed into the
// same WeChat account share `nickname` / `unionId`, which the mixer
// reads as the same user_id and treats as a session takeover — the
// "older" device gets displaced, the room collapses to a single user
// in the mixer's accounting, soloMode flips on, and the user hears
// their own voice through the server fullMix loop. Mixing in a 4-char
// random suffix per device decouples the identity without affecting
// nicknames in the UI (peers still display as the user-typed name
// because ChannelStrip slices to 8 chars when no nickname is provided).
//
// Guest users already get per-device IDs (separate localStorage), so
// this only matters for the logged-in path.
const DEVICE_ID_KEY = 'tonel_device_id'
function getDeviceSuffix(): string {
  let id: string | null = null
  try { id = localStorage.getItem(DEVICE_ID_KEY) } catch {}
  if (id && /^[A-Z0-9]{4}$/.test(id)) return id
  const fresh = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X').slice(0, 4)
  try { localStorage.setItem(DEVICE_ID_KEY, fresh) } catch {}
  return fresh
}
/** Decorate a logged-in user's identity with a per-device suffix so
 *  two devices on the same WeChat account get distinct mixer slots. */
function makeLoggedInUserId(base: string): string {
  return `${base}~${getDeviceSuffix()}`
}

// 用户服务 API 地址
const USER_API_BASE = import.meta.env.VITE_USER_API_URL || 'https://api.tonel.io'

// Deep-link parsing — `/room/<id>` is the canonical room URL.
// Returns the room id if the path matches, else null.
function parseRoomPath(pathname: string): string | null {
  const m = pathname.match(/^\/room\/([A-Za-z0-9_-]+)\/?$/)
  return m ? m[1] : null
}

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
  // Deep-link state: when the page loads on /room/<id>, show a password
  // prompt so the user can authenticate before we try to join.
  const [deepLinkRoomId, setDeepLinkRoomId] = useState<string | null>(null)
  const [deepLinkPassword, setDeepLinkPassword] = useState('')
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null)
  const [deepLinkSubmitting, setDeepLinkSubmitting] = useState(false)
  // Surfaced when the server sends SESSION_REPLACED — another device joined
  // with this user's id and our session was kicked. Toast + redirect home.
  const [sessionReplacedNotice, setSessionReplacedNotice] = useState(false)
  // v3.7.0: mobile drawer (hamburger menu) state. Only used by the
  // .tn-mnav block which is the < 768px nav.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const { peers, connect, createRoom, joinRoom, leaveRoom,
          sessionReplaced, acknowledgeSessionReplaced } = useSignal()

  // 初始化：检查登录状态
  useEffect(() => {
    const guestId = generateGuestId()
    setUserId(guestId)
    connect()

    // 如果有 token，验证并获取用户信息
    if (token) {
      fetchUserProfile(token)
    }

    // Deep-link: if the URL is /room/<id> on first load, surface a password
    // prompt. We don't try a no-password attempt first — always show the
    // prompt so the UX is uniform between password-protected and open rooms
    // (open rooms accept an empty password).
    const initialRoomId = parseRoomPath(window.location.pathname)
    if (initialRoomId) {
      setDeepLinkRoomId(initialRoomId)
    }

    // Browser back/forward — keep React state in sync with the URL.
    const onPop = () => {
      const id = parseRoomPath(window.location.pathname)
      if (id) {
        // Going back to a /room/<id> URL: show password prompt unless we're
        // already in that exact room.
        if (id !== roomIdRef.current) setDeepLinkRoomId(id)
      } else {
        // Back-button to /: leave the room if we're in one.
        if (roomIdRef.current) {
          leaveRoom()
          setRoomId('')
          setRoomPassword(undefined)
          setPage('home')
        }
        setDeepLinkRoomId(null)
      }
    }
    window.addEventListener('popstate', onPop)

    // v3.7.0: hash-based routing for the placeholder pages
    // (#pricing / #booking / #download). HomePage's CTAs set
    // location.hash; we watch it here and flip the page state.
    // Refused while in a room — don't pull the user out of audio
    // for a placeholder page.
    const onHash = () => {
      const h = (window.location.hash || '').toLowerCase()
      if (roomIdRef.current) return
      if (h === '#pricing')        setPage('pricing')
      else if (h === '#booking')   setPage('booking')
      else if (h === '#download')  setPage('download')
      else                         setPage('home')
    }
    window.addEventListener('hashchange', onHash)
    onHash()  // honour hash on initial load (e.g. shared link to #pricing)

    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('hashchange', onHash)
    }
  }, [])

  // Mirror roomId into a ref so popstate (which only captures the initial
  // closure) can read the current room without re-binding the listener.
  const roomIdRef = useRef('')
  useEffect(() => { roomIdRef.current = roomId }, [roomId])

  // Sync URL with room state. When entering a room, push /room/<id>; when
  // leaving, push / back. Using pushState (not replaceState) so the back
  // button can take the user out of the room.
  //
  // Pause sync while the deep-link modal is open: on first paint roomId is
  // still '' even though the URL is /room/<id>, and we don't want to clobber
  // the URL out from under the password prompt.
  useEffect(() => {
    if (deepLinkRoomId) return
    const targetPath = roomId ? `/room/${roomId}` : '/'
    if (window.location.pathname !== targetPath) {
      // Preserve the query string across the join transition so debug
      // flags like `?debug=1` survive into the room. Without this, the
      // deep-link → join flow lands on `/room/<id>` (no query), and the
      // AudioDebugPanel's `?debug=1` check at mount sees nothing.
      const targetUrl = targetPath + window.location.search + window.location.hash
      window.history.pushState({}, '', targetUrl)
    }
  }, [roomId, deepLinkRoomId])

  // SESSION_REPLACED: server told us another connection took over this uid.
  // Bail out of the room (if any) and show a toast.
  useEffect(() => {
    if (!sessionReplaced) return
    setSessionReplacedNotice(true)
    if (roomId) {
      leaveRoom()
      setRoomId('')
      setRoomPassword(undefined)
      setPage('home')
    }
  }, [sessionReplaced, roomId, leaveRoom])

  // 获取用户信息
  const fetchUserProfile = async (authToken: string) => {
    try {
      const res = await fetch(`${USER_API_BASE}/api/user/profile`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      })
      if (res.ok) {
        const data = await res.json()
        setUserProfile(data)
        setUserId(makeLoggedInUserId(data.nickname || data.unionId))
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
    setUserId(makeLoggedInUserId(profile.nickname || profile.unionId))
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

  const submitDeepLink = useCallback(async () => {
    if (!deepLinkRoomId || !userId) return
    setDeepLinkSubmitting(true)
    setDeepLinkError(null)
    try {
      // joinRoom throws on server error; surface the message inline so the
      // user can retry with a different password without leaving the prompt.
      await joinRoom(deepLinkRoomId, userId, '0.0.0.0', 9003,
                     deepLinkPassword || undefined)
      setRoomId(deepLinkRoomId)
      setRoomPassword(deepLinkPassword || undefined)
      setPage('room')
      setDeepLinkRoomId(null)
      setDeepLinkPassword('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加入房间失败'
      setDeepLinkError(msg)
    } finally {
      setDeepLinkSubmitting(false)
    }
  }, [deepLinkRoomId, deepLinkPassword, userId, joinRoom])

  const cancelDeepLink = useCallback(() => {
    setDeepLinkRoomId(null)
    setDeepLinkPassword('')
    setDeepLinkError(null)
    // Strip /room/<id> from URL so a refresh doesn't re-prompt.
    if (window.location.pathname !== '/') {
      window.history.replaceState({}, '', '/')
    }
  }, [])

  return (
    <div className="app-root">
      <MusicBackground />
      {/* v3.7.0 V1 nav — desktop bar (≥768px). The mobile equivalent
          (.tn-mnav) is rendered just below; CSS shows whichever
          matches the viewport. */}
      <nav className="tn-nav">
        <div className="tn-nav-left">
          <a href="/" className="tn-brand"
             onClick={(e) => { e.preventDefault(); window.location.hash = ''; setPage('home') }}>
            Tonel
          </a>
          <ul className="tn-nav-links">
            <li><a onClick={() => { window.location.hash = ''; setPage('home') }}>功能</a></li>
            <li><a onClick={() => { window.location.hash = '#pricing' }}>定价</a></li>
            <li><a onClick={() => { window.location.hash = '' /* TODO #docs route */ }}>文档</a></li>
            <li><a href="https://github.com/jaysonsu1993-a11y/Tonel" target="_blank" rel="noopener">
              GitHub <span className="tn-ext-arrow">↗</span>
            </a></li>
          </ul>
        </div>
        <div className="tn-nav-right">
          <button className="tn-btn tn-btn-ghost-sm"
                  onClick={() => { window.location.hash = '#download' }}>下载</button>
          {isLoggedIn ? (
            <div className="tn-user">
              {userProfile?.avatarUrl && <img src={userProfile.avatarUrl} alt="" />}
              <span>{userProfile?.nickname || userId}</span>
              <button className="tn-btn tn-btn-ghost-sm" onClick={handleLogout} style={{ marginLeft: 4 }}>
                退出
              </button>
            </div>
          ) : (
            <button className="tn-btn tn-btn-primary-sm" onClick={() => setShowLoginModal(true)}>
              登录
            </button>
          )}
        </div>
      </nav>

      {/* Mobile nav (<768px) — same actions, hamburger + drawer. */}
      <nav className="tn-mnav">
        <span className="tn-mnav-brand">Tonel</span>
        <button className="tn-mnav-burger" aria-label="menu"
                onClick={() => setMobileMenuOpen(m => !m)}>
          <span /><span /><span />
        </button>
      </nav>
      <div className={`tn-drawer${mobileMenuOpen ? ' open' : ''}`}>
        <button onClick={() => { setMobileMenuOpen(false); window.location.hash = ''; setPage('home') }}>功能</button>
        <button onClick={() => { setMobileMenuOpen(false); window.location.hash = '#pricing' }}>定价</button>
        <button onClick={() => { setMobileMenuOpen(false) /* TODO #docs */ }}>文档</button>
        <button onClick={() => { setMobileMenuOpen(false); window.location.hash = '#download' }}>下载桌面版 ↓</button>
        <a href="https://github.com/jaysonsu1993-a11y/Tonel" target="_blank" rel="noopener">GitHub ↗</a>
        {isLoggedIn ? (
          <button className="tn-drawer-login" onClick={handleLogout}>
            退出 ({userProfile?.nickname || userId})
          </button>
        ) : (
          <button className="tn-drawer-login"
                  onClick={() => { setMobileMenuOpen(false); setShowLoginModal(true) }}>
            登录
          </button>
        )}
      </div>

      {/* 微信登录弹窗 */}
      {showLoginModal && (
        <WechatLogin
          onSuccess={handleLoginSuccess}
          onClose={() => setShowLoginModal(false)}
        />
      )}

      {/* 深链密码弹窗 — URL 是 /room/<id> 时出现 */}
      {deepLinkRoomId && (
        <div className="modal-backdrop" onClick={cancelDeepLink}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>加入房间 {deepLinkRoomId}</h3>
            <p style={{ opacity: 0.7, fontSize: 14 }}>
              如果房间设有密码请输入；否则留空。
            </p>
            <input
              type="password"
              autoFocus
              placeholder="房间密码（无密码留空）"
              value={deepLinkPassword}
              onChange={(e) => { setDeepLinkPassword(e.target.value); setDeepLinkError(null) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !deepLinkSubmitting) submitDeepLink()
              }}
            />
            {deepLinkError && (
              <div className="error-text" style={{ color: '#e55', marginTop: 8 }}>
                {deepLinkError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={cancelDeepLink}>取消</button>
              <button className="btn btn-primary" onClick={submitDeepLink}
                      disabled={deepLinkSubmitting}>
                {deepLinkSubmitting ? '加入中…' : '进入房间'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 会话被顶号通知 */}
      {sessionReplacedNotice && (
        <div className="modal-backdrop" onClick={() => {
          setSessionReplacedNotice(false); acknowledgeSessionReplaced()
        }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>账号已在其他设备登录</h3>
            <p>
              你的账号在另一台设备进入了房间。本端为了避免冲突已退出当前房间。
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-primary" onClick={() => {
                setSessionReplacedNotice(false); acknowledgeSessionReplaced()
              }}>知道了</button>
            </div>
          </div>
        </div>
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
        {(page === 'pricing' || page === 'booking' || page === 'download') && (
          <Placeholder kind={page} onHome={() => { window.location.hash = ''; setPage('home') }} />
        )}
      </main>
    </div>
  )
}

/**
 * Placeholder for the v3.7.0 routes that exist in the design but
 * don't have a backing feature yet. Renders a minimal "Coming
 * soon" panel with a back-to-home button. Intentionally kept inline
 * (not a separate file) until any of these grow real content —
 * spinning up a `pages/` file for a 30-line stub is overhead.
 */
function Placeholder({ kind, onHome }: { kind: 'pricing' | 'booking' | 'download'; onHome: () => void }) {
  const titles = {
    pricing:  { tag: 'PRICING',  title: '定价方案',     blurb: '免费 / Pro / 团队三档计划。详细价格表正在整理。' },
    booking:  { tag: 'PRO TRIAL', title: 'Pro 预约试用', blurb: '想抢先体验 Pro 完整功能？预约接入流程开发中。' },
    download: { tag: 'DOWNLOAD', title: '下载桌面客户端', blurb: 'macOS / Windows 原生客户端正在打包。Web 版可直接使用。' },
  }
  const t = titles[kind]
  return (
    <div className="tn-placeholder">
      <div className="tag">● {t.tag}</div>
      <h1>{t.title}</h1>
      <p>{t.blurb}</p>
      <button className="tn-btn tn-btn-primary-sm" onClick={onHome}>← 返回主页</button>
    </div>
  )
}
