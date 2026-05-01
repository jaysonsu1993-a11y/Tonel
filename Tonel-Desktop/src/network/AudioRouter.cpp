// AudioRouter.cpp - Automatic routing between P2P Mesh and Mixer Server
#include "AudioRouter.h"
#include <juce_core/juce_core.h>

// ============================================================
// NetworkQualityMonitor Implementation
// ============================================================
NetworkQualityMonitor::NetworkQualityMonitor()
{
    reset();
}

void NetworkQualityMonitor::reset()
{
    std::fill(packetHistory_, packetHistory_ + WINDOW_SIZE, false);
    std::fill(latencyHistory_, latencyHistory_ + WINDOW_SIZE, 0);
    historyIndex_ = 0;
    historyCount_ = 0;
    currentQuality_.store(NetworkQuality::Good, std::memory_order_release);
}

void NetworkQualityMonitor::recordPacket(bool received, int latencyMs)
{
    packetHistory_[historyIndex_] = received;
    latencyHistory_[historyIndex_] = latencyMs;
    historyIndex_ = (historyIndex_ + 1) % WINDOW_SIZE;
    if (historyCount_ < WINDOW_SIZE)
        ++historyCount_;

    NetworkQuality q = evaluate();
    currentQuality_.store(q, std::memory_order_release);
}

NetworkQuality NetworkQualityMonitor::getQuality() const
{
    return currentQuality_.load(std::memory_order_acquire);
}

NetworkQuality NetworkQualityMonitor::evaluate() const
{
    if (historyCount_ < 5)
        return NetworkQuality::Good;

    int receivedCount = 0;
    int totalLatency = 0;
    int latencyCount = 0;

    for (int i = 0; i < historyCount_; ++i) {
        if (packetHistory_[i])
            ++receivedCount;
        if (latencyHistory_[i] > 0) {
            totalLatency += latencyHistory_[i];
            ++latencyCount;
        }
    }

    float lossRate = 1.0f - (static_cast<float>(receivedCount) / historyCount_);

    if (lossRate >= PACKET_LOSS_THRESHOLD)
        return NetworkQuality::Bad;

    int avgLatency = (latencyCount > 0) ? (totalLatency / latencyCount) : 0;

    if (avgLatency >= LATENCY_MEDIUM_MS)
        return NetworkQuality::Bad;
    if (avgLatency >= LATENCY_GOOD_MS)
        return NetworkQuality::Medium;

    return NetworkQuality::Good;
}

bool NetworkQualityMonitor::isGoodForP2P() const
{
    NetworkQuality q = getQuality();
    return q != NetworkQuality::Bad;
}

// ============================================================
// AudioRouter Implementation
// ============================================================
AudioRouter::AudioRouter()
{
}

AudioRouter::~AudioRouter()
{
    stop();
    if (mixer_) delete mixer_;
}

void AudioRouter::setP2PMeshManager(P2PMeshManager* p2p)
{
    p2p_ = p2p;
    if (p2p_)
        p2p_->setLocalUserId(localUserId_);
}

void AudioRouter::setMixerServerConnection(MixerServerConnectionInterface* mixer)
{
    mixer_ = mixer;
    if (mixer_)
        mixer_->setCallback(this);
}

void AudioRouter::setLocalUserId(const std::string& userId)
{
    localUserId_ = userId;
    if (p2p_)
        p2p_->setLocalUserId(userId);
    // Propagate to mixer connection if already set
    if (mixer_)
        mixer_->setRoomInfo(mixerRoomId_, localUserId_);
}

void AudioRouter::setMixerRoomId(const std::string& roomId)
{
    mixerRoomId_ = roomId;
    if (mixer_)
        mixer_->setRoomInfo(mixerRoomId_, localUserId_);
}

void AudioRouter::setDefaultMixerServer(const std::string& address, int port)
{
    defaultMixerAddr_ = address;
    defaultMixerPort_ = port;
}

void AudioRouter::init(int roomSize)
{
    roomSize_ = roomSize;
    p2pFailureCount_.store(0, std::memory_order_release);
    p2pSuccessCount_.store(0, std::memory_order_release);
    netMonitor_.reset();

    // ── 初始模式决策 ─────────────────────────────────────────────────────
    //
    // 房间人数决定首次使用的传输模式：
    //
    //   人数 >= MAX_P2P_SIZE + 1 = 5 人 → 强制 Mixer Server
    //     原因：全网状拓扑 5 人需要 10 条连接，NAT 打洞和带宽消耗都成问题，
    //           且 Mixer 模式可以享受服务器混音（每个用户听到的是混好的整体）。
    //
    //   人数 <= MAX_P2P_SIZE = 4 人 → 优先 P2P
    //     原因：Mesh 拓扑连接数可控（4 人 = 6 条连接），延迟最低，
    //           适合局域网或网络条件好的用户。
    //
    // 注意：这是初始推荐值，运行中会根据网络质量动态调整。
    //
    if (roomSize_ >= MAX_P2P_SIZE + 1) {
        // 5+ people: force mixer
        switchToMixer(defaultMixerAddr_.empty() ? "127.0.0.1" : defaultMixerAddr_);
    } else {
        // 2-4 people: start with P2P
        switchToP2P();
    }
}

void AudioRouter::start()
{
    if (mode_.load() == RouteMode::P2P && p2p_) {
        // P2P start is handled externally via setP2PMeshManager + joinMesh
    } else if (mode_.load() == RouteMode::Mixer && mixer_) {
        mixer_->setRoomInfo(mixerRoomId_, localUserId_);
        mixer_->connect(mixerAddr_.empty() ? defaultMixerAddr_ : mixerAddr_,
                        mixerPort_ > 0 ? mixerPort_ : defaultMixerPort_);
    }
}

void AudioRouter::stop()
{
    juce::ScopedLock lock(modeSwitchLock_);
    if (mixer_) {
        mixer_->disconnect();
    }
}

std::string AudioRouter::getMixerServer() const
{
    if (mode_.load() == RouteMode::Mixer)
        return mixerAddr_.empty() ? defaultMixerAddr_ : mixerAddr_;
    return {};
}

bool AudioRouter::isP2PActive() const
{
    return mode_.load() == RouteMode::P2P;
}

bool AudioRouter::isMixerActive() const
{
    return mode_.load() == RouteMode::Mixer;
}

void AudioRouter::recordP2PFailure()
{
    int failures = p2pFailureCount_.fetch_add(1) + 1;
    DBG("[AudioRouter] P2P failure " << failures << "/" << P2P_FAILURE_THRESHOLD);
    evaluateAndSwitch();
}

void AudioRouter::recordP2PSuccess()
{
    int successes = p2pSuccessCount_.fetch_add(1) + 1;
    // Reset failure count on sustained success
    if (successes > 10) {
        p2pFailureCount_.store(0, std::memory_order_release);
        p2pSuccessCount_.store(0, std::memory_order_release);
    }
}

void AudioRouter::reportPacketResult(bool received, int latencyMs)
{
    if (!received) {
        netMonitor_.recordPacket(false, 0);  // only record loss, no latency
        recordP2PFailure();
    } else {
        netMonitor_.recordPacket(true, latencyMs);
        recordP2PSuccess();
    }
}

void AudioRouter::onLocalAudioReady(const float* data, int frames, int channels)
{
    if (mode_.load() == RouteMode::P2P && p2p_) {
        // ── P2P 广播逻辑 ──────────────────────────────────────────────────
        //
        // 发送策略：将自己的麦克风音频同时广播给所有已连接的 peers（P2P Mesh）。
        //   调用 p2p_->sendAudioBroadcast()，内部会遍历所有活跃的 peer 连接并发送。
        //
        // Mesh 拓扑描述：
        //   - 全网状（Full Mesh）：每对成员之间都维持一条独立的 UDP 连接（WebRTC PeerConnection）。
        //   - 无需中心服务器中转，延迟最低（理论上只有一跳网络延迟）。
        //   - 成员离开/加入时，P2PMeshManager 负责维护连接状态并触发 meshPeerJoined / meshPeerLeft 回调。
        //   - 适用规模：<= 4 人（MAX_P2P_SIZE）。
        //
        // 同时，将最新一帧存入 loopbackBuffer_，供 getMixerPlayableSamples()
        //  later 回放给用户自己（实现"听到自己"的效果）。
        //
        p2p_->sendAudioBroadcast(data, frames, channels, 0, CODEC_PCM16);
        {
            juce::ScopedLock lock(loopbackLock_);
            int needed = frames * channels;
            if ((int)loopbackBuffer_.size() < needed)
                loopbackBuffer_.resize(needed);
            std::memcpy(loopbackBuffer_.data(), data, needed * sizeof(float));
            loopbackFrames_ = frames;
            loopbackChannels_ = channels;
        }
    } else if (mode_.load() == RouteMode::Mixer && mixer_ && mixer_->isConnected()) {
        // Mixer 模式：音频发送给服务器，由服务器混音后再分发。
        mixer_->sendAudio(data, frames, channels);
    }
    // If no route active, audio is dropped (logged externally)
}

void AudioRouter::meshAudioReceived(const float* buffer, int numSamples, int numChannels,
                                     const std::string& fromUserId)
{
    // P1-3: Audio is delivered via onTick → callback_->meshAudioReceived.
    // Do NOT also push to appCallback_ here — that would be a double pick
    // since the same audio may also be pulled through getMixerPlayableSamples.
    (void)buffer; (void)numSamples; (void)numChannels; (void)fromUserId;
}

void AudioRouter::meshPeerStateChanged(const std::string& userId, PeerConnectionState newState)
{
    DBG("[AudioRouter] Peer " << userId << " state: " << (int)newState);
    if (newState == PeerConnectionState::Failed) {
        recordP2PFailure();
    } else if (newState == PeerConnectionState::Active) {
        recordP2PSuccess();
    }
}

void AudioRouter::meshPeerJoined(const std::string& userId)
{
    DBG("[AudioRouter] Peer joined: " << userId);
}

void AudioRouter::meshPeerLeft(const std::string& userId)
{
    DBG("[AudioRouter] Peer left: " << userId);
}

void AudioRouter::meshNatTypeDetected(NatType type,
                                       const juce::String& mappedAddress,
                                       int mappedPort)
{
    DBG("[AudioRouter] NAT detected: " << (int)type << " addr: " << mappedAddress);
    // If symmetric NAT, consider forcing mixer
    if (type == NatType::Symmetric) {
        DBG("[AudioRouter] Symmetric NAT detected — may prefer mixer");
    }
}

void AudioRouter::mixerAudioReceived(const float* buffer, int numSamples, int numChannels)
{
    // P1-3: Removed appCallback_ path — mixer audio is now ONLY delivered
    // through getMixerPlayableSamples (audio thread pull) to prevent double pick.
    (void)buffer; (void)numSamples; (void)numChannels;
}

bool AudioRouter::getMixerPlayableSamples(float* out, int maxSamples)
{
    if (mode_.load() == RouteMode::Mixer && mixer_) {
        // Mixer 模式：音频来自服务器混音结果，由 mixer_->popPlayable() 拉取。
        // 服务器混音包含所有远端成员的音频，本地麦克风音频已由服务器侧混回（或通过其他路径回放）。
        return mixer_->popPlayable(out, maxSamples);
    }
    if (mode_.load() == RouteMode::P2P) {
        // ── P2P 模式下的本地回放（loopbackBuffer_） ─────────────────────────
        //
        // 在纯 P2P 模式下，没有服务器回流自己的麦克风信号。
        // 用户如果听不到自己的演奏，会难以判断节拍和音准。
        //
        // 此处从 loopbackBuffer_ 取出最近一帧本地麦克风音频并回放给用户，
        // 让用户在 P2P 模式下也能"听到自己"。
        //
        // 注意：这只是用户自己的麦克风信号（裸信号），
        //       不是其他人发来的音频（那些音频走独立的 P2P 接收路径）。
        //       不足的 sample 以 0 填充（静音垫底）。
        //
        juce::ScopedLock lock(loopbackLock_);
        if (loopbackBuffer_.empty() || loopbackFrames_ == 0)
            return false;
        int available = loopbackFrames_ * loopbackChannels_;
        int toCopy = std::min(maxSamples, available);
        std::memcpy(out, loopbackBuffer_.data(), toCopy * sizeof(float));
        if (toCopy < maxSamples)
            std::memset(out + toCopy, 0, (maxSamples - toCopy) * sizeof(float));
        return true;
    }
    return false;
}

void AudioRouter::switchToMixer(const std::string& mixerAddr)
{
    juce::ScopedLock lock(modeSwitchLock_);

    RouteMode prev = mode_.load();
    if (prev == RouteMode::Mixer && mixer_ && mixer_->isConnected())
        return; // Already on mixer with same address

    DBG("[AudioRouter] Switching to Mixer mode: " << mixerAddr);

    // 切换到 Mixer 前，先断开 P2P Mesh 连接（不再广播给 peers）。
    if (p2p_)
        p2p_->leaveMesh();

    // 连接 Mixer 服务器，所有音频改为发往服务器并从中接收混音结果。
    mixerAddr_ = mixerAddr;
    if (mixer_) {
        mixer_->setRoomInfo(mixerRoomId_, localUserId_);
        mixer_->connect(mixerAddr_, defaultMixerPort_);
    }

    mode_.store(RouteMode::Mixer, std::memory_order_release);

    if (appCallback_ && prev != mode_.load())
        appCallback_->onRouteModeChanged(RouteMode::Mixer);
}

void AudioRouter::switchToP2P()
{
    juce::ScopedLock lock(modeSwitchLock_);

    RouteMode prev = mode_.load();
    if (prev == RouteMode::P2P)
        return; // Already on P2P

    DBG("[AudioRouter] Switching to P2P mode");

    // Disconnect mixer
    if (mixer_)
        mixer_->disconnect();

    // Reset failure tracking for new attempt
    p2pFailureCount_.store(0, std::memory_order_release);
    p2pSuccessCount_.store(0, std::memory_order_release);

    mode_.store(RouteMode::P2P, std::memory_order_release);

    if (appCallback_ && prev != mode_.load())
        appCallback_->onRouteModeChanged(RouteMode::P2P);
}

void AudioRouter::evaluateAndSwitch()
{
    // ── Mixer Fallback 触发条件 ──────────────────────────────────────────
    //
    // evaluateAndSwitch() 在每次 P2P 失败/成功报告时被调用，
    // 评估当前网络状态，决定是否从 P2P 切换到 Mixer Server。
    //
    // 触发 Mixer Fallback 的三个条件（满足任一即切换）：
    //
    //  条件 1：房间人数超过上限
    //    roomSize_ >= MAX_P2P_SIZE + 1 (= 5 人)
    //    → Mesh 拓扑连接数爆炸（10 条连接），切换为星形的 Mixer 拓扑
    //
    //  条件 2：P2P 连续失败次数超阈值
    //    p2pFailureCount_ > P2P_FAILURE_THRESHOLD (= 3)
    //    → 说明 NAT 打洞失败或网络丢包严重，继续 P2P 无意义
    //
    //  条件 3：网络质量评估为 Bad
    //    !netMonitor_.isGoodForP2P()
    //    → 过去 50 个包的丢包率 >= 15% 或平均延迟 >= 80ms
    //
    // 注意事项：
    //  - 当前实现只允许 P2P → Mixer 的单向自动切换，
    //    Mixer → P2P 的恢复需要人工干预或房间人数变化触发重新 init()
    //    （这是有意的迟滞设计，防止在临界网络条件下频繁切换）
    //  - 如果已在 Mixer 模式，此函数直接返回（不做反向尝试）
    //
    if (mode_.load() == RouteMode::Mixer) {
        // Currently on mixer: evaluate if we should try P2P again
        // Only switch back if room size dropped AND network is good
        // (This is a one-way decision for now; manual retry could be added)
        return;
    }

    // P2P mode active: should we fall back to mixer?
    if (roomSize_ >= MAX_P2P_SIZE + 1) {
        DBG("[AudioRouter] Room size " << roomSize_ << " >= 5 — forcing mixer");
        switchToMixer(defaultMixerAddr_.empty() ? "127.0.0.1" : defaultMixerAddr_);
        return;
    }

    if (p2pFailureCount_.load() > P2P_FAILURE_THRESHOLD) {
        DBG("[AudioRouter] P2P failures " << p2pFailureCount_.load()
             << " > " << P2P_FAILURE_THRESHOLD << " — switching to mixer");
        switchToMixer(defaultMixerAddr_.empty() ? "127.0.0.1" : defaultMixerAddr_);
        return;
    }

    if (!netMonitor_.isGoodForP2P()) {
        DBG("[AudioRouter] Network quality Bad — switching to mixer");
        switchToMixer(defaultMixerAddr_.empty() ? "127.0.0.1" : defaultMixerAddr_);
        return;
    }
}
