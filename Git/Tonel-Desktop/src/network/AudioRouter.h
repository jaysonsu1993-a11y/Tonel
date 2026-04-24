// AudioRouter.h - Automatic routing between P2P Mesh and Mixer Server
//
// ═══════════════════════════════════════════════════════════════════════════
// 整体设计说明
// ═══════════════════════════════════════════════════════════════════════════
//
// AudioRouter 负责在两种音频传输模式之间自动切换：
//   - P2P Mesh 模式：所有成员两两直连，延迟最低，但成员数受网络质量限制
//   - Mixer Server 模式：音频汇聚到服务器混音后再分发，扩展性好，适合大规模或复杂网络环境
//
// 路由决策由以下因素共同驱动：
//   1. 房间人数（MAX_P2P_SIZE = 4 上限）
//   2. P2P 连接失败计数（连续失败 >= 3 次则 fallback）
//   3. 网络质量评估（丢包率 / 延迟）
//   4. NAT 类型（对称 NAT 优先选择 Mixer）
//
// ═══════════════════════════════════════════════════════════════════════════

#pragma once

#include "P2PMeshManager.h"
#include <juce_core/juce_core.h>

#include <string>
#include <atomic>
#include <memory>

// ============================================================
// Forward declarations
// ============================================================
class MixerServerConnectionInterface;

// ============================================================
// Network Quality Monitor
// ============================================================
enum class NetworkQuality { Good, Medium, Bad };

class NetworkQualityMonitor {
public:
    NetworkQualityMonitor();

    // Record a packet result
    void recordPacket(bool received, int latencyMs);

    // Get current network quality assessment
    NetworkQuality getQuality() const;

    // Quick check: is P2P viable right now?
    bool isGoodForP2P() const;

    // Reset statistics (e.g., on mode switch)
    void reset();

private:
    NetworkQuality evaluate() const;

    // Rolling window stats
    static constexpr int WINDOW_SIZE = 50;

    bool packetHistory_[WINDOW_SIZE] = { false };
    int latencyHistory_[WINDOW_SIZE]  = { 0 };
    int historyIndex_ = 0;
    int historyCount_ = 0;

    mutable std::atomic<NetworkQuality> currentQuality_{ NetworkQuality::Good };

    // Thresholds
    static constexpr int LATENCY_GOOD_MS   = 30;
    static constexpr int LATENCY_MEDIUM_MS = 80;
    static constexpr float PACKET_LOSS_THRESHOLD = 0.15f; // 15% loss = Bad
};

// ============================================================
// Mixer Server Connection (interface to be implemented)
// ============================================================
class MixerServerConnectionInterface {
public:
    virtual ~MixerServerConnectionInterface() = default;

    // Set room and user credentials (must be called before connect)
    virtual void setRoomInfo(const std::string& roomId, const std::string& userId) = 0;

    virtual void connect(const std::string& address, int port) = 0;
    virtual void disconnect() = 0;
    virtual bool isConnected() const = 0;
    virtual void sendAudio(const float* buffer, int numSamples, int numChannels) = 0;
    // Pull audio samples ready to play (call from audio engine audio thread)
    virtual bool popPlayable(float* outSamples, int maxSamples) = 0;
    virtual void setCallback(class AudioRouter* router) = 0;
};

// ============================================================
// Route Target
// ============================================================
enum class RouteMode { P2P, Mixer };

enum class RouteTarget {
    Local,   // Playback locally (from P2P received audio)
    Mixer,   // Send to mixer server
    Peer     // Send to other peers via P2P
};

// ============================================================
// Audio Router Callback
// ============================================================
class AudioRouterCallback {
public:
    virtual ~AudioRouterCallback() = default;
    virtual void onRouteModeChanged(RouteMode newMode) = 0;
    virtual void onRouteTargetNeeded(const float* buffer, int numSamples,
                                     int numChannels, RouteTarget target) = 0;
};

// ============================================================
// Audio Router
// ============================================================
class AudioRouter : public P2PMeshManagerCallback {
public:
    AudioRouter();
    ~AudioRouter();

    // ---- Configuration ----

    // Set P2P mesh manager (takes ownership not; caller owns lifetime)
    void setP2PMeshManager(P2PMeshManager* p2p);

    // Set mixer server connection (takes ownership; AudioRouter deletes it)
    void setMixerServerConnection(MixerServerConnectionInterface* mixer);

    // Set local user ID
    void setLocalUserId(const std::string& userId);

    // Set mixer server room ID (used when connecting to mixer server)
    void setMixerRoomId(const std::string& roomId);

    // Set default mixer server address (used when switching)
    void setDefaultMixerServer(const std::string& address, int port);

    // ---- Initialization ----

    // Initialize router with room size; determines initial mode
    void init(int roomSize);

    // Start the router
    void start();

    // Stop the router
    void stop();

    // ---- Mode & Status ----

    RouteMode getMode() const { return mode_.load(); }
    std::string getMixerServer() const;
    bool isP2PActive() const;
    bool isMixerActive() const;

    // ---- P2P Failures (called by external components) ----

    void recordP2PFailure();
    void recordP2PSuccess();

    // ---- Packet reporting (for network quality) ----

    void reportPacketResult(bool received, int latencyMs);

    // ---- Audio Flow ----

    // Called by AudioEngine when local mic audio is available — decide where to send it
    void onLocalAudioReady(const float* data, int frames, int channels);

    // P2PMeshManagerCallback: received remote audio from P2P
    void meshAudioReceived(const float* buffer, int numSamples, int numChannels,
                           const std::string& fromUserId) override;

    void meshPeerStateChanged(const std::string& userId,
                              PeerConnectionState newState) override;
    void meshPeerJoined(const std::string& userId) override;
    void meshPeerLeft(const std::string& userId) override;
    void meshNatTypeDetected(NatType type,
                             const juce::String& mappedAddress,
                             int mappedPort) override;

    // Mixer audio received (from server)
    void mixerAudioReceived(const float* buffer, int numSamples, int numChannels);

    // Pull playable mixed audio samples for the local audio engine.
    // Returns true if samples were written into `out`.
    bool getMixerPlayableSamples(float* out, int maxSamples);

    // ---- Router's own callback to the app layer ----

    void setCallback(AudioRouterCallback* cb) { appCallback_ = cb; }

private:
    void switchToMixer(const std::string& mixerAddr);
    void switchToP2P();
    void evaluateAndSwitch();

    // Room settings
    int roomSize_ = 0;
    static constexpr int MIN_P2P_SIZE = 2;
    static constexpr int MAX_P2P_SIZE = 4;
    // ── P2P Mesh 规模约束 ────────────────────────────────────────────────
    //
    // MAX_P2P_SIZE = 4 的意义：
    //   P2P Mesh 采用全网状（full-mesh）拓扑，即每对成员之间都有独立的 UDP 连接。
    //   4 人时共 6 条连接（n×(n-1)/2 = 4×3/2 = 6），尚可接受；
    //   5 人时升至 10 条连接，每位成员的发送/接收负担翻倍，NAT 打洞复杂度也显著增加。
    //   因此 5 人及以上默认强制走 Mixer Server，4 人及以下优先尝试 P2P。
    //
    // MIN_P2P_SIZE = 2：至少需要 2 人才有意义建立 P2P 连接。
    //
    // P2P_FAILURE_THRESHOLD = 3：连续 3 次 P2P 失败（丢包/连接超时/ICE 失败）
    //   触发自动切换到 Mixer Server 模式，防止在网络不稳定时持续尝试浪费资源。
    //
    static constexpr int P2P_FAILURE_THRESHOLD = 3;

    // Mode
    std::atomic<RouteMode> mode_{ RouteMode::P2P };

    // Sub-components
    P2PMeshManager* p2p_ = nullptr;
    MixerServerConnectionInterface* mixer_ = nullptr;

    // Mixers
    std::string mixerAddr_;
    int mixerPort_ = 0;
    std::string defaultMixerAddr_;
    int defaultMixerPort_ = 9000;

    // Network quality
    NetworkQualityMonitor netMonitor_;

    // P2P failure tracking
    std::atomic<int> p2pFailureCount_{ 0 };
    std::atomic<int> p2pSuccessCount_{ 0 };

    // User
    std::string localUserId_;
    std::string mixerRoomId_;

    // Callback
    AudioRouterCallback* appCallback_ = nullptr;

    // ── Local Loopback Buffer（本地回放缓冲）────────────────────────────
    //
    // loopbackBuffer_ 的作用：
    //   在 P2P 模式下，用户的麦克风音频会广播给其他 peers，但不会从服务器回流到用户自己。
    //   这导致用户听不到自己的声音——这对音乐人来说很别扭（无法判断自己的演奏是否正确）。
    //   loopbackBuffer_ 缓存最新一帧本地麦克风音频，在 getMixerPlayableSamples() 中
    //   将其混回给用户，实现"听到自己"的效果。
    //
    // 注意：这里只回放自己的麦克风音频（裸信号），而非其他 peers 发来的音频，
    //   因为在纯 P2P 模式下，其他 peers 的音频会通过 meshAudioReceived 回调由其他路径处理。
    //   Mixer 模式下则由 mixer_->popPlayable() 统一提供混音结果。
    //
    juce::CriticalSection loopbackLock_;
    std::vector<float> loopbackBuffer_;
    int loopbackFrames_ = 0;
    int loopbackChannels_ = 0;

    // Thread safety
    juce::CriticalSection modeSwitchLock_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioRouter)
};
