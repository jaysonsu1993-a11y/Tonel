// SignalingClient.h - TCP signaling client for connecting to the signaling server
#pragma once

#include <juce_core/juce_core.h>
#include <string>
#include <functional>
#include <vector>

// ============================================================
// Signaling message types (mirrors server/src/signaling_server.h)
// ============================================================
struct SignalingPeerInfo {
    std::string user_id;
    std::string ip;
    int port = 0;
};

struct SignalMessage {
    enum class Type {
        Unknown,
        CREATE_ROOM_ACK,
        JOIN_ROOM_ACK,
        PEER_LIST,
        PEER_JOINED,
        PEER_LEFT,
        ROOM_LIST,
        ERROR
    } type = Type::Unknown;
    std::string room_id;
    std::string user_id;
    std::string message;
    std::vector<SignalingPeerInfo> peers;
};

// ============================================================
// SignalingClient - TCP socket client for signaling server
// ============================================================
class SignalingClient {
public:
    // Callback interface
    class Callback {
    public:
        virtual ~Callback() = default;
        virtual void onSignalingConnected() = 0;
        virtual void onSignalingDisconnected() = 0;
        virtual void onSignalingError(const std::string& error) = 0;
        virtual void onRoomCreated(const std::string& roomId) = 0;
        virtual void onRoomJoined(const std::string& roomId) = 0;
        virtual void onPeerList(const std::string& roomId, const std::vector<SignalingPeerInfo>& peers) = 0;
        virtual void onPeerJoined(const SignalingPeerInfo& peer) = 0;
        virtual void onPeerLeft(const std::string& userId) = 0;
        virtual void onSignalingError(const std::string& roomId, const std::string& error) = 0;
    };

    SignalingClient();
    ~SignalingClient();

    void setCallback(Callback* cb) { callback_ = cb; }

    // Connect to signaling server
    bool connect(const std::string& host, int port);

    // Disconnect
    void disconnect();

    // Create a room (call before join)
    void createRoom(const std::string& roomId, const std::string& userId, const std::string& password = "");

    // Join an existing room
    void joinRoom(const std::string& roomId, const std::string& userId,
                  const std::string& password = "",
                  const std::string& localIp = "", int localPort = 0);

    // Leave room
    void leaveRoom(const std::string& roomId, const std::string& userId);

    bool isConnected() const { return connected_.load(std::memory_order_acquire); }

private:
    void receiveThreadFunc();
    void processLine(const std::string& line);
    SignalMessage parseMessage(const std::string& json) const;
    std::string extract(const std::string& json, const std::string& key) const;
    int extractInt(const std::string& json, const std::string& key) const;
    void send(const std::string& msg);

    std::unique_ptr<juce::StreamingSocket> socket_;
    std::atomic<bool> connected_{false};
    std::atomic<bool> running_{false};
    std::thread receiveThread_;
    std::string serverHost_;
    int serverPort_ = 0;
    Callback* callback_ = nullptr;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SignalingClient)
};
