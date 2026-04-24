// S1SignalingClient.h — WebSocket signaling client using NSURLSessionWebSocketTask (macOS 10.15+)
//
// Uses WebSocket via Apple's native NSURLSessionWebSocketTask instead of raw TCP sockets,
// so it can connect through the ws-proxy (port 9004) without requiring direct TCP access.
#pragma once

#include <string>
#include <vector>
#include <functional>
#include <thread>
#include <atomic>
#include <mutex>
#include <chrono>

// ── Peer info (mirrors SignalingPeerInfo) ─────────────────────────────────────

struct S1PeerInfo {
    std::string user_id;
    std::string ip;
    int         port = 0;
};

// ── Callback interface ────────────────────────────────────────────────────────

class S1SignalingCallback {
public:
    virtual ~S1SignalingCallback() = default;

    virtual void onSignalingConnected()                                         = 0;
    virtual void onSignalingDisconnected()                                      = 0;
    virtual void onSignalingError(const std::string& error)                    = 0;

    virtual void onRoomCreated(const std::string& roomId)                      = 0;
    virtual void onRoomJoined (const std::string& roomId)                      = 0;
    virtual void onRoomJoinFailed(const std::string& error)                    = 0;

    virtual void onPeerList(const std::string& roomId,
                            const std::vector<S1PeerInfo>& peers)              = 0;
    virtual void onPeerJoined(const S1PeerInfo& peer)                          = 0;
    virtual void onPeerLeft  (const std::string& userId)                       = 0;

    // Non-pure: default no-op so existing implementations don't need to change
    virtual void onLatencyMeasured(int ms) { (void)ms; }
};

// ── Client ────────────────────────────────────────────────────────────────────
// Implemented via an opaque Objective-C++ pimpl to use NSURLSessionWebSocketTask

class S1SignalingClient {
public:
    S1SignalingClient();
    ~S1SignalingClient();

    void setCallback(S1SignalingCallback* cb) { callback_ = cb; }

    bool connect   (const std::string& host, int port);
    void disconnect();

    void createRoom(const std::string& roomId, const std::string& userId,
                    const std::string& password = "");
    void joinRoom  (const std::string& roomId, const std::string& userId,
                    const std::string& localIp = "", int localPort = 0,
                    const std::string& password = "");
    void leaveRoom (const std::string& roomId, const std::string& userId);

    bool isConnected() const { return connected_.load(std::memory_order_acquire); }

    // Called by the ObjC++ pimpl when a WebSocket message arrives
    void onMessage(const std::string& json);
    // Called by the ObjC++ pimpl when the WebSocket connection closes
    void onDisconnect();

private:
    void processLine(const std::string& line);
    void send(const std::string& json);

    // Minimal JSON helpers (no external lib needed for our simple protocol)
    std::string jsonString(const std::string& key, const std::string& val) const;
    std::string jsonInt   (const std::string& key, int val)                 const;
    std::string extractStr(const std::string& json, const std::string& key) const;
    int         extractInt(const std::string& json, const std::string& key) const;
    std::vector<S1PeerInfo> extractPeers(const std::string& json)           const;

    // Opaque handle to the Objective-C++ WebSocket session wrapper
    void* websocketSession_ = nullptr;

    std::atomic<bool>    connected_{ false };
    std::mutex           sendMutex_;
    std::string          recvBuf_;
    S1SignalingCallback* callback_ = nullptr;

    std::chrono::steady_clock::time_point pingTime_;
};
