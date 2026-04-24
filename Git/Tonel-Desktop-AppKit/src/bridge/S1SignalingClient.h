// S1SignalingClient.h — WebSocket signaling client for macOS 10.15+
// Uses NSURLSessionWebSocketTask through nginx proxy (wss://tonel.io/signaling).
#pragma once

#include <string>
#include <vector>
#include <atomic>
#include <mutex>

struct S1PeerInfo {
    std::string user_id;
    std::string ip;
    int         port = 0;
};

class S1SignalingCallback {
public:
    virtual ~S1SignalingCallback() = default;
    virtual void onSignalingConnected()                                     = 0;
    virtual void onSignalingDisconnected()                                  = 0;
    virtual void onSignalingError(const std::string& error)                = 0;
    virtual void onRoomCreated(const std::string& roomId)                  = 0;
    virtual void onRoomJoined(const std::string& roomId)                   = 0;
    virtual void onRoomJoinFailed(const std::string& error)                = 0;
    virtual void onPeerList(const std::string& roomId,
                            const std::vector<S1PeerInfo>& peers)          = 0;
    virtual void onPeerJoined(const S1PeerInfo& peer)                      = 0;
    virtual void onPeerLeft(const std::string& userId)                     = 0;
    virtual void onLatencyMeasured(int ms)                                 { (void)ms; }
};

// NSObjects forward-declared here, defined in .mm
@class WSClientDelegate;
@class NSURLSession;
@class NSURLSessionWebSocketTask;

// Pimpl struct — only instantiated inside the .mm file
struct WSClientPimpl {
    WSClientDelegate* delegate;
    NSURLSession* session;
    NSURLSessionWebSocketTask* task;
};

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

    // Delegate callbacks — called from WSClientDelegate
    void onMessage(const std::string& json);
    void onDisconnect();
    void onSignalingConnected();
    void onSignalingError(const std::string& error);

private:
    void processLine(const std::string& line);
    void send(const std::string& json);

    std::string jsonString(const std::string& k, const std::string& v) const;
    std::string jsonInt   (const std::string& k, int v)                 const;
    std::string extractStr(const std::string& json, const std::string& key) const;
    int         extractInt(const std::string& json, const std::string& key) const;
    std::vector<S1PeerInfo> extractPeers(const std::string& json)       const;

    WSClientPimpl* pimpl_ = nullptr;
    std::atomic<bool>    connected_{ false };
    std::mutex           sendMutex_;
    S1SignalingCallback* callback_ = nullptr;
};
