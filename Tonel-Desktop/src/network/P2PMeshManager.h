// P2PMeshManager.h - P2P Mesh routing for multi-user audio streaming
#pragma once

#include "StunClient.h"
#include <juce_core/juce_core.h>
#include <juce_audio_basics/juce_audio_basics.h>

#include <string>
#include <vector>
#include <unordered_map>
#include <mutex>
#include <condition_variable>
#include <memory>
#include <deque>
#include <thread>

// ============================================================
// Audio Packet Format (SPA1)
// ============================================================
#pragma pack(push, 1)
struct AudioPacket {
    uint32_t magic;        // 0x53415031 ("SPA1")
    uint16_t sequence;     // Sequence number
    uint16_t timestamp;    // Timestamp (audio sample counter, uint16_t at 48kHz wraps ~1.36s;未用于排序)
    uint8_t  userId[32];   // User ID (null-terminated string)
    uint8_t  codec;        // 0=PCM 16-bit, 1=Opus (P1-2: 字段存在但当前版本忽略，解码由调用方决定)
    uint16_t dataSize;     // Audio payload size
    uint8_t  data[];       // Audio data (variable length)
};
#pragma pack(pop)

constexpr uint32_t AUDIO_PACKET_MAGIC   = 0x53415031;
constexpr uint16_t AUDIO_PACKET_HEADER_SIZE = 44;
constexpr uint8_t  CODEC_PCM16          = 0;
constexpr uint8_t  CODEC_OPUS           = 1;
constexpr int      MAX_PACKET_SIZE      = 1400; // MTU-safe
constexpr int      MAX_PAYLOAD_SIZE     = 1356; // P0-3: dataSize上限，防止大内存分配

// ============================================================
// Peer Connection State
// ============================================================
enum class PeerConnectionState {
    Disconnected,
    Connecting,    // Exchanging ICE candidates
    Connected,     // P2P UDP established
    Active,        // Audio flowing
    Failed
};

struct PeerInfo {
    std::string userId;
    juce::String ip;
    int port = 0;
    PeerConnectionState state = PeerConnectionState::Disconnected;
    int64_t lastHeartbeat = 0;
    int64_t connectStartTime = 0;
    bool isLocal = false;
    // P0-1: ICE candidate info for hole punching
    juce::String peerCandidateIp;
    int peerCandidatePort = 0;
    bool candidateSent = false;
    // Hole-punch retry tracking
    int punchRetryCount = 0;
    int64_t lastPunchTime = 0;
    bool holePunchConfirmed = false;
    // P2-1: TURN fallback flag (set when hole punching fails after max retries)
    bool needsTurnFallback = false;
};

// ============================================================
// Jitter Buffer Entry
// ============================================================
struct JitterBufferEntry {
    uint16_t sequence;
    uint16_t timestamp;
    juce::MemoryBlock payload;
    int64_t receivedAt;   // monotonic ms
    bool played = false;
    uint8_t codec = CODEC_PCM16; // P1-2: store codec for correct decoding
};

// ============================================================
// P2P Mesh Manager Interface
// ============================================================
class P2PMeshManagerCallback {
public:
    virtual ~P2PMeshManagerCallback() = default;

    // Called when audio is received from a remote peer (after jitter buffer)
    virtual void meshAudioReceived(const float* buffer, int numSamples,
                                   int numChannels, const std::string& fromUserId) = 0;

    // Called when a peer's connection state changes
    virtual void meshPeerStateChanged(const std::string& userId,
                                      PeerConnectionState newState) = 0;

    // Called when a new peer joins the mesh
    virtual void meshPeerJoined(const std::string& userId) = 0;

    // Called when a peer leaves the mesh
    virtual void meshPeerLeft(const std::string& userId) = 0;

    // Called when local STUN/NAT detection completes
    virtual void meshNatTypeDetected(NatType type,
                                     const juce::String& mappedAddress,
                                     int mappedPort) = 0;
};

// ============================================================
// P2P Mesh Manager
// ============================================================
class P2PMeshManager {
public:
    explicit P2PMeshManager(P2PMeshManagerCallback* callback);
    ~P2PMeshManager();

    // ---- Configuration ----

    void setLocalUserId(const std::string& userId);
    void setSignalingServer(const juce::String& url, int port);
    void setAudioFormat(int sampleRate, int channels, int samplesPerPacket);

    // ---- Lifecycle ----

    bool start(int bindPort = 8000);
    void stop();

    // ---- Mesh Management ----

    void joinMesh(const std::vector<std::string>& peerUserIds);
    void leaveMesh();
    void addPeer(const std::string& userId);
    void removePeer(const std::string& userId);

    // ---- Audio ----

    // Broadcast audio to all connected peers
    void sendAudioBroadcast(const float* buffer, int numSamples, int numChannels,
                            uint16_t timestamp, uint8_t codec = CODEC_PCM16);

    // Send audio to a specific peer (unicast)
    void sendAudioToPeer(const std::string& userId, const float* buffer,
                         int numSamples, int numChannels,
                         uint16_t timestamp, uint8_t codec = CODEC_PCM16);

    // Feed a raw UDP packet to the mesh (from NetworkSocket)
    void onPacketReceived(const void* data, int size,
                          const juce::String& fromIP, int fromPort);

    // Called periodically (~10ms) to advance jitter buffer and deliver audio
    void onTick();

    // ---- Status ----

    int getPeerCount() const;
    PeerConnectionState getPeerState(const std::string& userId) const;
    NatType getNatType() const { return natType_; }
    bool isRunning() const { return running_.load(); }
    int getJitterBufferDepth(const std::string& userId) const;
    float getPeerJitterMs(const std::string& userId) const;

private:
    // ---- Thread classes (inner subclasses of juce::Thread) ----

    class ReceiveThread : public juce::Thread {
    public:
        explicit ReceiveThread(P2PMeshManager& m) : Thread("P2PMesh Rx"), man(m) {}
        void run() override;
    private:
        P2PMeshManager& man;
    };

    class HeartbeatThread : public juce::Thread {
    public:
        explicit HeartbeatThread(P2PMeshManager& m) : Thread("P2PMesh HB"), man(m) {}
        void run() override;
    private:
        P2PMeshManager& man;
    };

    // ---- Signaling thread (TCP connection to signaling server) ----
    class SignalingThread : public juce::Thread {
    public:
        explicit SignalingThread(P2PMeshManager& m) : Thread("P2PMesh Signal"), man(m) {}
        void run() override;
    private:
        P2PMeshManager& man;
    };

    // ---- Internal helpers ----

    void processReceivedPacket(const void* data, int size,
                               const juce::String& fromIP, int fromPort);

    void connectToPeer(const std::string& userId);
    void disconnectFromPeer(const std::string& userId);

    PeerInfo* findPeerByAddress(const juce::String& ip, int port);
    PeerInfo* findPeer(const std::string& userId);

    void sendToPeer(const std::string& userId, const void* data, int size);
    void broadcastToAllPeers(const void* data, int size);

    // Jitter Buffer
    void jitterBufferPush(const std::string& userId,
                          uint16_t sequence, uint16_t timestamp,
                          const uint8_t* payload, int payloadSize,
                          int64_t nowMs, uint8_t codec);
    bool jitterBufferPop(const std::string& userId, float* outSamples,
                         int maxSamples, int64_t nowMs);
    bool jitterBufferPopImpl(const std::string& userId, float* outSamples,
                         int maxSamples, int64_t nowMs);
    void jitterBufferDrainExpired(const std::string& userId, int64_t nowMs);

    // NAT detection
    void detectNatTypeAsync();

    // Signaling server connection
    void signalingConnect();
    void signalingSend(const juce::String& json);
    void onSignalingMessage(const juce::String& msg);
    void handleSignalingPeerList(const juce::String& roomId,
                                  const juce::String& peersJson);
    void handleSignalingIceCandidate(const juce::String& fromUser,
                                     const juce::String& candidateIp,
                                     int candidatePort);
    void handleSignalingPeerJoined(const juce::String& userId,
                                     const juce::String& ip, int port);

    // NAT hole punching: initiate UDP punch
    void punchHole(const std::string& userId);
    // NAT hole punching: respond/confirm hole
    void punchHoleConfirm(const std::string& userId,
                          const juce::String& peerIp, int peerPort);

    // P0-1: Send local ICE candidate to signaling server
    void sendLocalCandidate(const std::string& targetUserId);
    // P0-1: Send our mapped address as our candidate
    void announceLocalCandidate();

    P2PMeshManagerCallback* callback_ = nullptr;

    std::string localUserId_;
    juce::String signalingUrl_;
    int signalingPort_ = 0;
    int bindPort_ = 8000;

    // Network
    std::unique_ptr<juce::DatagramSocket> socket_;
    std::unique_ptr<StunClient> stunClient_;

    ReceiveThread receiveThread_;
    HeartbeatThread heartbeatThread_;
    SignalingThread signalingThread_;
    std::atomic<bool> running_{false};

    // Peers
    std::unordered_map<std::string, PeerInfo> peers_;
    mutable std::mutex peersMutex_; // P0-5: mutable for const methods

    // Jitter buffers (one per peer) — protected by peersMutex_ (P0-6)
    std::unordered_map<std::string, std::deque<JitterBufferEntry>> jitterBuffers_;

    // Audio format
    int sampleRate_ = 48000;
    int numChannels_ = 2;
    int samplesPerPacket_ = 480; // 10ms at 48kHz

    // NAT
    NatType natType_ = NatType::Unknown;
    juce::String mappedAddress_;
    int mappedPort_ = 0;

    // NAT detection thread
    std::atomic<bool> natDetectRunning_{false};
    std::thread natDetectThread_;
    std::mutex natDetectMutex_;
    std::condition_variable natDetectCond_;

    // Signaling: message queue for persistent TCP connection
    std::deque<juce::String> signalingQueue_;
    std::mutex signalingQueueMutex_;
    std::condition_variable signalingQueueCond_;

    // Sequence counter
    std::atomic<uint16_t> sequence_{0};

    // Monotonic start time (ms)
    int64_t startTime_{0};

    static constexpr int JITTER_BUFFER_MAX_DEPTH = 32;
    static constexpr int HEARTBEAT_INTERVAL_MS  = 3000;
    static constexpr int PEER_TIMEOUT_MS         = 10000;

    // P0-1: Hole-punch confirmation magic (small UDP packet to confirm connectivity)
    static constexpr uint32_t HOLEPUNCH_MAGIC    = 0x48504531; // "HPE1"
    static constexpr int HOLE_PUNCH_PORT_OFFSET  = 0; // send directly to peer port

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(P2PMeshManager)
};
