import { useState, useEffect, useCallback } from 'react'
import { signalService } from '../services/signalService'
import type { PeerInfo, SignalingMessage } from '../types'

export function useSignal() {
  const [isConnected, setIsConnected] = useState(false)
  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const unsub = signalService.onMessage((msg: SignalingMessage) => {
      if (msg.type === 'PEER_LIST') {
        const m = msg as { type: string; peers: PeerInfo[] }
        setPeers(m.peers)
      } else if (msg.type === 'PEER_JOINED') {
        const m = msg as { type: string; peer: PeerInfo }
        setPeers(prev => {
          if (prev.find(p => p.user_id === m.peer.user_id)) return prev
          return [...prev, m.peer]
        })
      } else if (msg.type === 'PEER_LEFT') {
        const m = msg as { type: string; user_id: string }
        setPeers(prev => prev.filter(p => p.user_id !== m.user_id))
      } else if (msg.type === 'ERROR') {
        const m = msg as { type: string; message: string }
        setError(m.message)
      }
    })
    return () => {
      unsub()
    }
  }, [])

  const connect = useCallback(async () => {
    try {
      setError(null)
      await signalService.connect()
      setIsConnected(true)
    } catch (err) {
      setError('无法连接到信令服务器')
      console.error(err)
    }
  }, [])

  const joinRoom = useCallback(async (roomId: string, userId: string, ip: string, port: number, password?: string) => {
    try {
      setError(null)
      await signalService.joinRoom(roomId, userId, ip, port, password)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加入房间失败'
      setError(msg)
      throw err
    }
  }, [])

  const leaveRoom = useCallback(async () => {
    await signalService.leaveRoom()
    setPeers([])
  }, [])

  const createRoom = useCallback(async (roomId: string, userId: string, password?: string) => {
    try {
      setError(null)
      await signalService.createRoom(roomId, userId, password)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '创建房间失败'
      setError(msg)
      throw err
    }
  }, [])

  const disconnect = useCallback(async () => {
    await signalService.disconnect()
    setIsConnected(false)
  }, [])

  return {
    isConnected,
    peers,
    error,
    connect,
    createRoom,
    joinRoom,
    leaveRoom,
    disconnect,
  }
}
