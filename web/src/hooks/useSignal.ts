import { useState, useEffect, useCallback } from 'react'
import { signalService } from '../services/signalService'
import type { PeerInfo } from '../types'

export function useSignal() {
  const [isConnected, setIsConnected] = useState(false)
  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sessionReplaced, setSessionReplaced] = useState(false)

  useEffect(() => {
    const unsub = signalService.onMessage((msg) => {
      if (msg.type === 'PEER_LIST') {
        setPeers(msg.peers)
      } else if (msg.type === 'PEER_JOINED') {
        setPeers(prev => {
          if (prev.find(p => p.user_id === msg.peer.user_id)) return prev
          return [...prev, msg.peer]
        })
      } else if (msg.type === 'PEER_LEFT') {
        setPeers(prev => prev.filter(p => p.user_id !== msg.user_id))
      } else if (msg.type === 'ERROR') {
        setError(msg.message)
      } else if (msg.type === 'SESSION_REPLACED') {
        // Surface to App so it can route back home with a notice.
        setSessionReplaced(true)
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

  const joinRoom = useCallback(async (roomId: string, userId: string, password?: string) => {
    try {
      setError(null)
      await signalService.joinRoom(roomId, userId, password)
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

  const acknowledgeSessionReplaced = useCallback(() => {
    setSessionReplaced(false)
    signalService.resetSessionReplaced()
  }, [])

  return {
    isConnected,
    peers,
    error,
    sessionReplaced,
    acknowledgeSessionReplaced,
    connect,
    createRoom,
    joinRoom,
    leaveRoom,
    disconnect,
  }
}
