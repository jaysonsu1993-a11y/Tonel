// 信令消息类型
export interface PeerInfo {
  user_id: string
  ip: string
  port: number
  nickname?: string
  avatar_url?: string
}

export interface SignalingMessage {
  type: string
  [key: string]: unknown
}

export interface JoinRoomMessage extends SignalingMessage {
  type: 'JOIN_ROOM'
  room_id: string
  user_id: string
  ip: string
  port: number
}

export interface PeerListMessage extends SignalingMessage {
  type: 'PEER_LIST'
  peers: PeerInfo[]
}

export interface PeerJoinedMessage extends SignalingMessage {
  type: 'PEER_JOINED'
  peer: PeerInfo
}

export interface IceCandidateMessage extends SignalingMessage {
  type: 'ICE_CANDIDATE'
  candidate: RTCIceCandidateInit
  from: string
  to: string
}

// WebRTC 配置
export interface RTCConfig {
  iceServers: RTCIceServer[]
}

// 房间成员
export interface RoomMember {
  userId: string
  ip: string
  port: number
  muted: boolean
  level: number // 音频电平 0-100
}

// 登录信息
export interface LoginInfo {
  phone?: string
  wechat?: string
  userId: string
}

// 用户资料（微信登录后）
export interface UserProfile {
  id: number
  unionId: string
  nickname: string
  avatarUrl: string
  membershipType: 'free' | 'basic' | 'pro'
  membershipExpiresAt?: number
}

// 页面状态.
// `pricing` / `booking` / `download` are placeholder routes added by
// the v3.7.0 V1 homepage redesign — see App.tsx for the implementation
// stubs (each currently renders a "Coming soon" panel).
export type PageState = 'login' | 'home' | 'room' | 'pricing' | 'booking' | 'download'
