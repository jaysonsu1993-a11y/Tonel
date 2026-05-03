// Tonel web client — shared types.

// A peer (a fellow room member). v5.1.19: dropped `ip`/`port` — those
// were leftover from the dead P2P path; the server no longer sends
// them and the client never used them.
export interface PeerInfo {
  user_id: string
  nickname?: string
  avatar_url?: string
}

// Login info (phone OTP / wechat OAuth).
export interface LoginInfo {
  phone?: string
  wechat?: string
  userId: string
}

// User profile populated after wechat login.
export interface UserProfile {
  id: number
  unionId: string
  nickname: string
  avatarUrl: string
  membershipType: 'free' | 'basic' | 'pro'
  membershipExpiresAt?: number
}

// Top-level route state. `pricing` / `booking` / `download` are
// placeholder routes from the v3.7.0 V1 homepage redesign — each
// currently renders a "Coming soon" panel in App.tsx.
export type PageState = 'login' | 'home' | 'room' | 'pricing' | 'booking' | 'download'
