import { useState, useEffect, useRef } from 'react'
import type { PeerInfo } from '../types'
import { mixerRttProbe } from '../services/mixerRttProbe'

/**
 * HomePage — V1 redesign (2026-04-29).
 *
 * Spec: design_handoff_homepage_v1/README.md.
 *
 * Renders the hero with a giant live-RTT number as the visual anchor.
 * Same component handles desktop and mobile via parallel `.v1` and
 * `.v1m` blocks gated by media-query CSS in globals.css. Both blocks
 * always mount; CSS hides whichever doesn't match the current width
 * — that's simpler than a JS-side matchMedia branch and correctly
 * handles a window resize without remounting state.
 *
 * Props are unchanged from the prior HomePage. Auxiliary surfaces
 * (`/pricing`, `/booking`, `/download`) are routed by `App.tsx`'s
 * page state — `HomePage` only owns the home view itself.
 *
 * Existing behaviour preserved:
 *   - `免费创建房间`  → onCreateRoom(generatedId)        (no panel)
 *   - `加入房间`      → showJoinPanel for room id + password
 *   - createError / joinError surfaced inline near the relevant CTA
 */

interface Props {
  isLoggedIn: boolean
  userProfile?: import('../types').UserProfile | null
  onCreateRoom: (roomId: string, password?: string) => Promise<void>
  onJoinRoom:   (roomId: string, password?: string) => Promise<void>
  onClearJoinError: () => void
  peers: PeerInfo[]
  joinError?: string | null
  createError?: string | null
}

/**
 * Live latency number, used in three slots on the home page (hero
 * giant number, hero axis line, bottom stats row). All three slots
 * subscribe to the mixer-server PING/PONG RTT (same figure shown
 * inside a live room) so they show the same value at the same time.
 *
 * Display rules per spec:
 *   - Pre-connect / no RTT yet → animated 12 ± `jitter` placeholder.
 *   - < 50 ms  → green
 *   - 50–99 ms → yellow
 *   - >= 100 ms → red
 *
 * UI throttle ≥ 200 ms so the digit doesn't strobe on rapid pings.
 */
function LiveLatency({ baseMs = 12, jitter = 2 }: { baseMs?: number; jitter?: number }) {
  const [ms, setMs] = useState<number>(baseMs)
  const [haveReal, setHaveReal] = useState(false)
  const lastUiUpdate = useRef(0)
  useEffect(() => {
    mixerRttProbe.start()
    const unsub = mixerRttProbe.onLatency((rtt) => {
      const now = Date.now()
      // Throttle to >= 200 ms between visible updates.
      if (now - lastUiUpdate.current < 200) return
      lastUiUpdate.current = now
      setMs(rtt)
      setHaveReal(true)
    })
    return unsub
  }, [])
  // Mock pulse for the pre-connect placeholder — keeps the digit
  // visually alive so a stale-looking page isn't mistaken for a
  // broken page during the first second after load.
  useEffect(() => {
    if (haveReal) return
    const id = setInterval(() => {
      setMs(baseMs + Math.round((Math.random() - 0.5) * jitter * 2))
    }, 220)
    return () => clearInterval(id)
  }, [haveReal, baseMs, jitter])
  // Rendered as plain numeric text — the parent CSS class (.v1-num,
  // .v1-cell .v) controls font, size, color. We don't override
  // colour here so the .lit / pre-set tone classes win.
  return <>{ms}</>
}

export function HomePage({
  isLoggedIn: _isLoggedIn,
  userProfile: _userProfile,
  onCreateRoom,
  onJoinRoom,
  onClearJoinError,
  peers: _peers,
  joinError,
  createError,
}: Props) {
  const [isCreating, setIsCreating] = useState(false)
  const [isJoining,  setIsJoining]  = useState(false)
  const [showJoinPanel, setShowJoinPanel] = useState(false)
  const [joinRoomId,    setJoinRoomId]    = useState('')
  const [joinPassword,  setJoinPassword]  = useState('')
  // v3.7.1: restore the interactive create flow. The design spec
  // suggested zero-friction (auto-generated id, no panel), but the
  // user wants the prior behaviour — explicit room id + optional
  // password — back. Modal-style panel mirrors the join panel below.
  const [showCreatePanel, setShowCreatePanel] = useState(false)
  const [pendingRoomId,   setPendingRoomId]   = useState('')
  const [createPassword,  setCreatePassword]  = useState('')

  /** Open the create panel. Empty id field — user can type a custom
   *  room number or leave blank for auto-generation on confirm. */
  const handleCreateClick = () => {
    setPendingRoomId('')
    setCreatePassword('')
    setShowCreatePanel(true)
  }
  const handleCreateConfirm = async () => {
    if (isCreating) return
    setIsCreating(true)
    try {
      const id = pendingRoomId.trim().toUpperCase()
        || Math.random().toString(36).slice(2, 8).toUpperCase()
      await onCreateRoom(id, createPassword || undefined)
      setShowCreatePanel(false)
    } finally {
      setIsCreating(false)
    }
  }
  const handleCreateCancel = () => {
    setShowCreatePanel(false)
    setPendingRoomId('')
    setCreatePassword('')
  }

  const handleJoinClick = () => {
    onClearJoinError()
    setJoinRoomId('')
    setJoinPassword('')
    setShowJoinPanel(true)
  }

  const handleJoinConfirm = async () => {
    if (joinRoomId.trim().length < 1 || isJoining) return
    setIsJoining(true)
    try {
      await onJoinRoom(joinRoomId.trim().toUpperCase(), joinPassword || undefined)
      setShowJoinPanel(false)
    } finally {
      setIsJoining(false)
    }
  }
  const handleJoinCancel = () => {
    setShowJoinPanel(false)
    setJoinRoomId(''); setJoinPassword(''); onClearJoinError()
  }

  return (
    <>
      {/* ─── DESKTOP (≥ 768px via globals.css media query) ─── */}
      <div className="v1">
        <div className="v1-bg-grid" />
        <div className="v1-statusbar">
          <span><span className="dot">●</span> SIGNALING ONLINE</span>
          <span>SAMPLE 48000 HZ</span>
          <span>BUFFER 128</span>
          <span>CODEC OPUS 96K</span>
          <span style={{ marginLeft: 'auto', color: '#888' }}>BUILD 2026.04.29</span>
        </div>

        <div className="v1-stage">
          <div className="v1-left">
            <div className="v1-tag">REAL-TIME · LOSSLESS · CHINA-MAINLAND</div>
            <h1 className="v1-headline">
              合奏的<span className="strike">距离</span><br />
              <span className="accent">不再有距离。</span>
            </h1>
            <p className="v1-sub">
              忘掉视频会议的延迟。Tonel 用专为音频写的网络协议，把每个乐手的声音运回同一个房间——不是比喻，是物理意义上的同一拍。
            </p>
            <div className="v1-actions">
              <button className="v1-cta" onClick={handleCreateClick} disabled={isCreating}>
                {isCreating ? '创建中…' : '免费创建房间'}
              </button>
              <button className="v1-cta-ghost" onClick={handleJoinClick}>加入房间</button>
              <button className="v1-link" onClick={() => bookingNav()}>预约 Pro 试用 →</button>
            </div>
            {createError && (
              <p style={{ marginTop: 12, fontSize: 13, color: '#f87171' }}>{createError}</p>
            )}
            <div className="v1-bullets">
              <span><b>14,200+</b> 累计排练小时</span>
              <span><b>JUCE / miniaudio</b> 双引擎</span>
              <span><b>macOS · Windows · Web</b></span>
            </div>
          </div>

          <div className="v1-right">
            <div className="v1-axis">
              <div>200ms ─ 视频会议</div>
              <div>120ms ─ 蓝牙耳机</div>
              <div style={{ color: '#facc15' }}>50ms ─ 可感知</div>
              <div className="here">12ms ─ TONEL ◀</div>
              <div>10ms ─ 同房间空气声</div>
            </div>
            <div className="v1-num-wrap">
              <div className="v1-num">
                <LiveLatency /><span className="v1-unit">ms</span>
              </div>
              <div className="v1-num-label">END-TO-END · LIVE FROM SHANGHAI ↔ BEIJING</div>
              <div className="v1-num-decor" />
            </div>
          </div>
        </div>

        <div className="v1-bottom">
          <div className="v1-cell">
            <span className="k">Latency</span>
            <span className="v lit"><LiveLatency /> ms</span>
          </div>
          <div className="v1-cell">
            <span className="k">Active rooms</span>
            <span className="v">2,481</span>
          </div>
          <div className="v1-cell">
            <span className="k">Musicians online</span>
            <span className="v">8,640</span>
          </div>
          <div className="v1-cell">
            <span className="k">Uptime · 30d</span>
            <span className="v lit">99.97%</span>
          </div>
        </div>
      </div>

      {/* ─── MOBILE (< 768px via globals.css) ─── */}
      <div className="v1m">
        <div className="v1m-status">
          <span><span className="dot">●</span> ONLINE</span>
          <span>48 kHz · OPUS 96K</span>
        </div>

        <div className="v1m-hero">
          <div className="v1m-tag">REAL-TIME · LOSSLESS</div>
          <div className="v1m-num-wrap">
            <div className="v1m-num">
              <LiveLatency /><span className="v1m-unit">ms</span>
            </div>
            <div className="v1m-num-label">END-TO-END · 上海 ↔ 北京</div>
          </div>

          <div className="v1m-axis">
            <div className="row">
              <span className="lbl">视频会议</span>
              <div className="bar"><span style={{ width: '100%' }} /></div>
              <span className="num">200</span>
            </div>
            <div className="row">
              <span className="lbl">蓝牙耳机</span>
              <div className="bar"><span style={{ width: '60%' }} /></div>
              <span className="num">120</span>
            </div>
            <div className="row warn">
              <span className="lbl">可感知阈值</span>
              <div className="bar"><span style={{ width: '25%' }} /></div>
              <span className="num">50</span>
            </div>
            <div className="row good">
              <span className="lbl">Tonel ◀</span>
              <div className="bar"><span style={{ width: '6%' }} /></div>
              <span className="num">12</span>
            </div>
          </div>

          <h1 className="v1m-headline">
            合奏的<span className="strike">距离</span>
            <br /><span className="accent">不再有距离。</span>
          </h1>
          <p className="v1m-sub">
            忘掉视频会议的延迟。Tonel 用专为音频写的网络协议，把每个乐手的声音运回同一个房间——不是比喻，是物理意义上的同一拍。
          </p>
        </div>

        <div className="v1m-actions">
          <button className="v1m-cta" onClick={handleCreateClick} disabled={isCreating}>
            {isCreating ? '创建中…' : '免费创建房间'}
          </button>
          <div className="v1m-row2">
            <button className="v1m-ghost" onClick={handleJoinClick}>加入房间</button>
            <button className="v1m-ghost" onClick={() => bookingNav()}>预约时段</button>
          </div>
          <button className="v1m-link" onClick={() => downloadNav()}>下载桌面客户端 →</button>
          {createError && (
            <p style={{ fontSize: 13, color: '#f87171', textAlign: 'center', margin: 0 }}>{createError}</p>
          )}
        </div>

        <div className="v1m-stats">
          <div className="cell"><span className="k">LATENCY</span><span className="v lit"><LiveLatency /> ms</span></div>
          <div className="cell"><span className="k">ACTIVE ROOMS</span><span className="v">2,481</span></div>
          <div className="cell"><span className="k">ONLINE</span><span className="v">8,640</span></div>
          <div className="cell"><span className="k">UPTIME 30D</span><span className="v lit">99.97%</span></div>
        </div>

        <div className="v1m-foot">
          <span>JUCE / miniaudio</span>
          <span>BUILD 2026.04.29</span>
        </div>
      </div>

      {/* Create panel — modal overlay. Same shape as the join panel
          for visual consistency. Empty room id field auto-generates
          a 6-char upper-case id on confirm. */}
      {showCreatePanel && (
        <div className="modal-backdrop" onClick={handleCreateCancel}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>创建房间</h3>
            <input
              type="text"
              autoFocus
              placeholder="自定义房间号（留空自动生成）"
              value={pendingRoomId}
              onChange={(e) => setPendingRoomId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !isCreating) void handleCreateConfirm() }}
              maxLength={20}
            />
            <input
              type="password"
              placeholder="设置密码（可选）"
              value={createPassword}
              onChange={(e) => setCreatePassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !isCreating) void handleCreateConfirm() }}
            />
            {createError && (
              <div className="error-text" style={{ color: '#e55', marginTop: 8 }}>
                {createError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={handleCreateCancel} disabled={isCreating}>取消</button>
              <button className="btn btn-primary" onClick={handleCreateConfirm} disabled={isCreating}>
                {isCreating ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Join panel — modal-like overlay, shared by desktop + mobile.
          Kept as a centred panel rather than inlined in the hero row
          because the hero is fixed-layout per spec; an inline
          expand-in-place would break the 1:1 grid. */}
      {showJoinPanel && (
        <div className="modal-backdrop" onClick={handleJoinCancel}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>加入房间</h3>
            <input
              type="text"
              autoFocus
              placeholder="输入房间号"
              value={joinRoomId}
              onChange={(e) => { setJoinRoomId(e.target.value.toUpperCase()); onClearJoinError() }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !isJoining) void handleJoinConfirm() }}
              maxLength={8}
            />
            <input
              type="password"
              placeholder="密码（如有）"
              value={joinPassword}
              onChange={(e) => { setJoinPassword(e.target.value); onClearJoinError() }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !isJoining) void handleJoinConfirm() }}
            />
            {joinError && (
              <div className="error-text" style={{ color: '#e55', marginTop: 8 }}>
                {joinError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={handleJoinCancel} disabled={isJoining}>取消</button>
              <button className="btn btn-primary" onClick={handleJoinConfirm}
                      disabled={isJoining || joinRoomId.trim().length < 1}>
                {isJoining ? '连接中…' : '加入'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Navigation hooks for the placeholder pages — each just sets the URL
// hash so App.tsx's page state reacts. Kept as plain functions (not
// hooks) so the component stays a single useState/useEffect block.
function bookingNav () { window.location.hash = '#booking' }
function downloadNav () { window.location.hash = '#download' }
