// P2PMeshManager.cpp - P2P Mesh routing implementation
#include "P2PMeshManager.h"
#include "ConfigManager.h"
#include <chrono>
#include <cstring>
#include <thread>
#include <atomic>

using namespace std::chrono;

// ============================================================
// Network byte order helpers
// ============================================================
static inline uint16_t net16(uint16_t v) {
    return (uint16_t)((v >> 8) | (v << 8));
}
static inline uint32_t net32(uint32_t v) {
    return ((v >> 24)) | ((v >> 8) & 0x0000FF00) | ((v << 8) & 0x00FF0000) | ((v << 24));
}
static inline uint16_t fromNet16(const uint8_t* p) {
    return ((uint16_t)p[0] << 8) | p[1];
}
static inline uint32_t fromNet32(const uint8_t* p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

// ============================================================
// Heartbeat Packet
// ============================================================
#pragma pack(push, 1)
struct HeartbeatPacket {
    uint32_t magic;
    uint8_t  userId[32];
    uint32_t timestamp;
};
#pragma pack(pop)
constexpr uint32_t HEARTBEAT_MAGIC = 0x48425431;

// ============================================================
// Hole-Punch confirmation packet
// ============================================================
#pragma pack(push, 1)
struct HolePunchPacket {
    uint32_t magic;      // HOLEPUNCH_MAGIC
    uint8_t  userId[32]; // sender userId
    uint32_t timestamp;  // monotonic ms
};
#pragma pack(pop)

// ============================================================
// Minimal JSON helpers (no external dep)
// ============================================================
static juce::String jsonFieldStr(const juce::String& json,
                                  const char* key) {
    juce::String search = "\"" + juce::String(key) + "\"";
    int kp = json.indexOf(search);
    if (kp < 0) return {};
    int vp = json.indexOf(kp, juce::String(":"));
    if (vp < 0) return {};
    ++vp;
    while (vp < json.length() && json[vp] <= ' ') ++vp;
    if (vp >= json.length()) return {};
    if (json[vp] != '"') return {};
    ++vp;
    int end = json.indexOf(juce::CharPointer_UTF8("\""));
    if (end < 0 || end < vp) return {};
    return json.substring(vp, end);
}

static int jsonFieldInt(const juce::String& json, const char* key) {
    juce::String search = "\"" + juce::String(key) + "\"";
    int kp = json.indexOf(search);
    if (kp < 0) return 0;
    int vp = json.indexOf(kp, juce::String(":"));
    if (vp < 0) return 0;
    ++vp;
    while (vp < json.length() && json[vp] <= ' ') ++vp;
    int end = vp;
    while (end < json.length() && json[end] > ' ') ++end;
    return json.substring(vp, end).getIntValue();
}

static juce::String makeJsonStr(const char* key, const char* val) {
    return "{\"" + juce::String(key) + "\":\"" + juce::String(val) + "\"}";
}
static juce::String makeJsonInt(const char* key, int val) {
    return "{\"" + juce::String(key) + "\":" + juce::String(val) + "}";
}
static juce::String makeJoinRoomMsg(const std::string& roomId,
                                    const std::string& userId,
                                    const juce::String& localIp,
                                    int localPort) {
    return "{\"type\":\"JOIN_ROOM\","
           "\"room_id\":\"" + juce::String(roomId) + "\","
           "\"user_id\":\"" + juce::String(userId) + "\","
           "\"ip\":\"" + localIp + "\","
           "\"port\":" + juce::String(localPort) + "}";
}
static juce::String makeIceCandidateMsg(const std::string& targetUserId,
                                         const juce::String& fromUserId,
                                         const juce::String& ip,
                                         int port) {
    return "{\"type\":\"ICE_CANDIDATE\","
           "\"target_user_id\":\"" + juce::String(targetUserId) + "\","
           "\"from_user\":\"" + fromUserId + "\","
           "\"ip\":\"" + ip + "\","
           "\"port\":" + juce::String(port) + "}";
}
static juce::String makeLeaveMsg(const std::string& roomId,
                                  const std::string& userId) {
    return "{\"type\":\"LEAVE_ROOM\","
           "\"room_id\":\"" + juce::String(roomId) + "\","
           "\"user_id\":\"" + juce::String(userId) + "\"}";
}

// ============================================================
// Construction / Destruction
// ============================================================
P2PMeshManager::P2PMeshManager(P2PMeshManagerCallback* callback)
    : callback_(callback)
    , receiveThread_(*this)
    , heartbeatThread_(*this)
    , signalingThread_(*this)
{
    stunClient_ = std::make_unique<StunClient>();
}

P2PMeshManager::~P2PMeshManager()
{
    stop();
}

// ============================================================
// Configuration
// ============================================================
void P2PMeshManager::setLocalUserId(const std::string& userId)
{
    localUserId_ = userId;
}

void P2PMeshManager::setSignalingServer(const juce::String& url, int port)
{
    signalingUrl_ = url;
    signalingPort_ = port;
}

void P2PMeshManager::setAudioFormat(int sampleRate, int channels, int samplesPerPacket)
{
    sampleRate_ = sampleRate;
    numChannels_ = channels;
    samplesPerPacket_ = samplesPerPacket;
}

// ============================================================
// Lifecycle
// ============================================================
bool P2PMeshManager::start(int bindPort)
{
    if (running_.load()) return false;

    bindPort_ = bindPort;

    socket_ = std::make_unique<juce::DatagramSocket>(false);
    if (!socket_->bindToPort(bindPort)) {
        printf("[P2PMesh] ERROR: Failed to bind UDP socket to port %d\n", bindPort);
        if (!socket_->bindToPort(0)) {
            printf("[P2PMesh] ERROR: Failed to bind UDP socket at all\n");
            return false;
        }
    }
    printf("[P2PMesh] UDP socket bound to port %d\n", socket_->getBoundPort());

    running_ = true;
    startTime_ = duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();

    receiveThread_.startThread(juce::Thread::Priority::high);
    heartbeatThread_.startThread(juce::Thread::Priority::low);

    detectNatTypeAsync();
    // P1-1: Wait for STUN to complete before sending JOIN_ROOM.
    // mappedPort_ must be valid when the signaling thread sends JOIN_ROOM
    // so peers receive our correct external address.
    {
        std::unique_lock<std::mutex> lock(natDetectMutex_);
        natDetectCond_.wait_for(lock, std::chrono::seconds(5), [this] {
            return !natDetectRunning_.load();
        });
    }
    signalingConnect();

    printf("[P2PMesh] Started\n");
    return true;
}

void P2PMeshManager::stop()
{
    if (!running_.load()) return;
    running_ = false;

    receiveThread_.stopThread(500);
    heartbeatThread_.stopThread(500);
    signalingThread_.stopThread(500);

    // Join NAT detection thread
    if (natDetectThread_.joinable()) {
        natDetectRunning_ = false;
        natDetectThread_.join();
    }

    if (signalingUrl_.isNotEmpty() && !localUserId_.empty()) {
        signalingSend(makeLeaveMsg("default_room", localUserId_));
    }

    {
        std::lock_guard<std::mutex> lock(peersMutex_);
        peers_.clear();
        jitterBuffers_.clear();
    }

    socket_.reset();
    printf("[P2PMesh] Stopped\n");
}

// ============================================================
// Mesh Management
// ============================================================
void P2PMeshManager::joinMesh(const std::vector<std::string>& peerUserIds)
{
    printf("[P2PMesh] joinMesh: %zu peers\n", peerUserIds.size());
    for (const auto& uid : peerUserIds) {
        if (uid != localUserId_)
            addPeer(uid);
    }
}

void P2PMeshManager::leaveMesh()
{
    printf("[P2PMesh] leaveMesh\n");
    std::lock_guard<std::mutex> lock(peersMutex_);
    for (auto& [uid, peer] : peers_)
        peer.state = PeerConnectionState::Disconnected;
    peers_.clear();
    jitterBuffers_.clear();
}

void P2PMeshManager::addPeer(const std::string& userId)
{
    PeerInfo info;
    info.userId = userId;
    info.state = PeerConnectionState::Connecting;
    info.connectStartTime = duration_cast<milliseconds>(
        steady_clock::now().time_since_epoch()).count();
    info.lastHeartbeat = info.connectStartTime;

    {
        std::lock_guard<std::mutex> lock(peersMutex_);
        if (peers_.find(userId) != peers_.end()) return;
        peers_[userId] = info;
        jitterBuffers_[userId] = std::deque<JitterBufferEntry>();
        printf("[P2PMesh] Peer added: %s\n", userId.c_str());
    }

    if (callback_) callback_->meshPeerJoined(userId);
    connectToPeer(userId);
}

void P2PMeshManager::removePeer(const std::string& userId)
{
    disconnectFromPeer(userId);

    {
        std::lock_guard<std::mutex> lock(peersMutex_);
        peers_.erase(userId);
        jitterBuffers_.erase(userId);
    }

    printf("[P2PMesh] Peer removed: %s\n", userId.c_str());
    if (callback_) callback_->meshPeerLeft(userId);
}

// ============================================================
// Peer Connection — P0-1: real hole punching via signaling
// ============================================================
void P2PMeshManager::connectToPeer(const std::string& userId)
{
    {
        std::lock_guard<std::mutex> lock(peersMutex_);
        auto it = peers_.find(userId);
        if (it != peers_.end()) {
            it->second.state = PeerConnectionState::Connecting;
            if (callback_)
                callback_->meshPeerStateChanged(userId, PeerConnectionState::Connecting);
        }
    }

    // Send our local ICE candidate to signaling for this target peer
    sendLocalCandidate(userId);
}

void P2PMeshManager::disconnectFromPeer(const std::string& userId)
{
    std::lock_guard<std::mutex> lock(peersMutex_);
    auto it = peers_.find(userId);
    if (it != peers_.end()) {
        it->second.state = PeerConnectionState::Disconnected;
        if (callback_)
            callback_->meshPeerStateChanged(userId, PeerConnectionState::Disconnected);
    }
}

PeerInfo* P2PMeshManager::findPeerByAddress(const juce::String& ip, int port)
{
    std::lock_guard<std::mutex> lock(peersMutex_);
    for (auto& [uid, peer] : peers_) {
        if (peer.ip == ip && peer.port == port)
            return &peer;
    }
    return nullptr;
}

PeerInfo* P2PMeshManager::findPeer(const std::string& userId)
{
    std::lock_guard<std::mutex> lock(peersMutex_);
    auto it = peers_.find(userId);
    return (it != peers_.end()) ? &it->second : nullptr;
}

int P2PMeshManager::getPeerCount() const
{
    std::lock_guard<std::mutex> lock(peersMutex_);
    return (int)peers_.size();
}

PeerConnectionState P2PMeshManager::getPeerState(const std::string& userId) const
{
    std::lock_guard<std::mutex> lock(peersMutex_);
    auto it = peers_.find(userId);
    if (it != peers_.end()) return it->second.state;
    return PeerConnectionState::Disconnected;
}

// ============================================================
// P0-1: Send local ICE candidate to signaling server
// ============================================================
void P2PMeshManager::sendLocalCandidate(const std::string& targetUserId)
{
    juce::String candIp  = mappedAddress_;
    int         candPort = mappedPort_;

    // Fallback: use local bind address if STUN hasn't completed yet
    if (candIp.isEmpty() && socket_) {
        candIp  = "127.0.0.1";
        candPort = socket_->getBoundPort();
    }
    if (candIp.isEmpty()) return;

    juce::String msg = makeIceCandidateMsg(targetUserId, localUserId_, candIp, candPort);
    signalingSend(msg);
}

// ============================================================
// P0-1: Announce our candidates after STUN completes
// ============================================================
void P2PMeshManager::announceLocalCandidate()
{
    if (localUserId_.empty()) return;

    juce::String ip  = mappedAddress_;
    int         port = mappedPort_;
    if (ip.isEmpty() && socket_) {
        ip   = "127.0.0.1";
        port = socket_->getBoundPort();
    }
    if (ip.isEmpty()) return;

    // Broadcast to all existing peers via signaling
    juce::String msg = makeIceCandidateMsg("*", localUserId_, ip, port);
    signalingSend(msg);
}

// ============================================================
// P0-1: Initiate NAT hole punch — send UDP bursts to peer's public address
// ============================================================
void P2PMeshManager::punchHole(const std::string& userId)
{
    juce::String peerIp;
    int peerPort = 0;
    int64_t nowMs = duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();

    {
        std::lock_guard<std::mutex> lock(peersMutex_);
        auto it = peers_.find(userId);
        if (it == peers_.end()) return;
        peerIp  = it->second.peerCandidateIp;
        peerPort = it->second.peerCandidatePort;
        // Reset hole punch confirmed flag on new punch attempt
        it->second.holePunchConfirmed = false;
    }

    if (peerIp.isEmpty() || peerPort == 0) {
        printf("[P2PMesh] punchHole: no peer candidate for %s\n", userId.c_str());
        return;
    }

    HolePunchPacket hp;
    hp.magic = net32(HOLEPUNCH_MAGIC);
    memset(hp.userId, 0, 32);
    memcpy(hp.userId, localUserId_.c_str(),
           juce::jmin((int)localUserId_.size(), 31));
    hp.timestamp = net32((uint32_t)nowMs);

    // Send burst — both sides must punch for NAT mapping to be created
    for (int i = 0; i < 5; ++i) {
        if (socket_)
            socket_->write(peerIp, peerPort, &hp, sizeof(hp));
        juce::Thread::sleep(10);
    }

    printf("[P2PMesh] punchHole: sent %d packets to %s:%d for %s\n",
           5, peerIp.toRawUTF8(), peerPort, userId.c_str());
}

// ============================================================
// P0-1: Confirm hole punch (send back to peer that reached us first)
// ============================================================
void P2PMeshManager::punchHoleConfirm(const std::string& userId,
                                       const juce::String& peerIp, int peerPort)
{
    HolePunchPacket hp;
    hp.magic = net32(HOLEPUNCH_MAGIC);
    memset(hp.userId, 0, 32);
    memcpy(hp.userId, localUserId_.c_str(),
           juce::jmin((int)localUserId_.size(), 31));
    hp.timestamp = net32((uint32_t)duration_cast<milliseconds>(
        steady_clock::now().time_since_epoch()).count());

    if (socket_)
        socket_->write(peerIp, peerPort, &hp, sizeof(hp));

    printf("[P2PMesh] punchHoleConfirm: sent to %s:%d for %s\n",
           peerIp.toRawUTF8(), peerPort, userId.c_str());
}

// ============================================================
// Receive Thread
// ============================================================
void P2PMeshManager::ReceiveThread::run()
{
    printf("[P2PMesh] Receive loop started\n");

    uint8_t buffer[MAX_PACKET_SIZE * 2];
    juce::String senderIP;
    int senderPort = 0;

    while (!threadShouldExit()) {
        if (!man.socket_ || man.socket_->getBoundPort() < 0) {
            sleep(50);
            continue;
        }

        if (man.socket_->waitUntilReady(true, 10) == 1) {
            int n = man.socket_->read(buffer, sizeof(buffer), false, senderIP, senderPort);
            if (n > 0)
                man.processReceivedPacket(buffer, n, senderIP, senderPort);
        }
    }

    printf("[P2PMesh] Receive loop exited\n");
}

// ============================================================
// Heartbeat Thread
// ============================================================
void P2PMeshManager::HeartbeatThread::run()
{
    printf("[P2PMesh] Heartbeat loop started\n");

    HeartbeatPacket hb;
    hb.magic = net32(HEARTBEAT_MAGIC);
    memset(hb.userId, 0, 32);

    while (!threadShouldExit()) {
        wait(HEARTBEAT_INTERVAL_MS);
        if (threadShouldExit()) break;

        uint32_t ts = (uint32_t)std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count();
        hb.timestamp = net32(ts);

        if (!man.localUserId_.empty()) {
            memcpy(hb.userId, man.localUserId_.c_str(),
                   juce::jmin((int)man.localUserId_.size(), 31));
        }
        man.broadcastToAllPeers(&hb, sizeof(hb));
    }

    printf("[P2PMesh] Heartbeat loop exited\n");
}

void P2PMeshManager::onPacketReceived(const void* data, int size,
                                       const juce::String& fromIP, int fromPort)
{
    processReceivedPacket(data, size, fromIP, fromPort);
}

// ============================================================
// Packet Processing
// ============================================================
void P2PMeshManager::processReceivedPacket(const void* data, int size,
                                            const juce::String& fromIP, int fromPort)
{
    if (size < 4) return;

    const uint8_t* p = (const uint8_t*)data;
    uint32_t magic = fromNet32(p);

    // Heartbeat
    if (magic == net32(HEARTBEAT_MAGIC)) {
        if ((size_t)size < sizeof(HeartbeatPacket)) return;
        const HeartbeatPacket* hb = (const HeartbeatPacket*)p;
        std::string uid((const char*)hb->userId, 32);
        size_t nullPos = uid.find('\0');
        if (nullPos != std::string::npos) uid.resize(nullPos);

        std::lock_guard<std::mutex> lock(peersMutex_);
        auto it = peers_.find(uid);
        if (it != peers_.end()) {
            it->second.lastHeartbeat = duration_cast<milliseconds>(
                steady_clock::now().time_since_epoch()).count();
            if (fromIP.isNotEmpty() && fromPort > 0) {
                it->second.ip = fromIP;
                it->second.port = fromPort;
            }
        }
        return;
    }

    // P0-1: Hole-punch packet received — peer can reach us
    if (magic == net32(HOLEPUNCH_MAGIC)) {
        if ((size_t)size < sizeof(HolePunchPacket)) return;
        const HolePunchPacket* hp = (const HolePunchPacket*)p;
        std::string uid((const char*)hp->userId, 32);
        size_t nullPos = uid.find('\0');
        if (nullPos != std::string::npos) uid.resize(nullPos);
        if (uid == localUserId_) return;

        {
            std::lock_guard<std::mutex> lock(peersMutex_);
            auto it = peers_.find(uid);
            if (it != peers_.end()) {
                it->second.ip = fromIP;
                it->second.port = fromPort;
                it->second.lastHeartbeat = duration_cast<milliseconds>(
                    steady_clock::now().time_since_epoch()).count();
                it->second.holePunchConfirmed = true;
                it->second.punchRetryCount = 0; // reset retries on success

                if (it->second.state == PeerConnectionState::Connecting ||
                    it->second.state == PeerConnectionState::Connected) {
                    it->second.state = PeerConnectionState::Active;
                    printf("[P2PMesh] Hole punch succeeded: %s (%s:%d)\n",
                           uid.c_str(), fromIP.toRawUTF8(), fromPort);
                    if (callback_)
                        callback_->meshPeerStateChanged(uid,
                            PeerConnectionState::Active);
                }
            }
        }
        return;
    }

    if (magic != AUDIO_PACKET_MAGIC) return;
    if (size < (int)AUDIO_PACKET_HEADER_SIZE) return;

    uint16_t seq   = net16(((const AudioPacket*)p)->sequence);
    uint16_t dsz   = net16(((const AudioPacket*)p)->dataSize);
    // codec field: P1-2 — stored but not used in this version;
    // decoding is delegated to the caller via meshAudioReceived callback.
    uint8_t  codec = ((const AudioPacket*)p)->codec;
    (void)codec;

    std::string uid((const char*)((const AudioPacket*)p)->userId, 32);
    size_t nullPos = uid.find('\0');
    if (nullPos != std::string::npos) uid.resize(nullPos);
    if (uid == localUserId_) return;

    int64_t nowMs = duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();

    // P0-3: Validate dataSize against MAX_PAYLOAD_SIZE
    if (dsz == 0 || dsz > MAX_PAYLOAD_SIZE) {
        printf("[P2PMesh] WARNING: dropped packet with invalid dataSize=%u from %s\n",
               dsz, uid.c_str());
        return;
    }

    if (size >= (int)AUDIO_PACKET_HEADER_SIZE + (int)dsz) {
        const uint8_t* payload = p + AUDIO_PACKET_HEADER_SIZE;
        // P1-2: Pass codec so jitterBufferPush can store it
        jitterBufferPush(uid, seq,
                         net16(((const AudioPacket*)p)->timestamp),
                         payload, (int)dsz, nowMs, codec);
    }
}

// ============================================================
// Jitter Buffer — P0-4: std::deque for O(1) pop_front
// P0-6: Protected by peersMutex_ only (no nested jitterMutex_)
// ============================================================
void P2PMeshManager::jitterBufferPush(const std::string& userId,
                                       uint16_t sequence, uint16_t timestamp,
                                       const uint8_t* payload, int payloadSize,
                                       int64_t nowMs, uint8_t codec)
{
    std::lock_guard<std::mutex> lock(peersMutex_);
    auto& buf = jitterBuffers_[userId];

    for (const auto& e : buf) {
        if (e.sequence == sequence) return; // drop duplicate
    }

    JitterBufferEntry entry;
    entry.sequence = sequence;
    entry.timestamp = timestamp;
    entry.payload = juce::MemoryBlock(payload, payloadSize);
    entry.receivedAt = nowMs;
    entry.played = false;
    entry.codec = codec; // P1-2: store codec for correct decoding

    // Insert in sorted order — O(n) vs O(n log n) full sort
    auto it = std::upper_bound(buf.begin(), buf.end(), entry,
                               [](const JitterBufferEntry& a, const JitterBufferEntry& b) {
                                   return a.sequence < b.sequence;
                               });
    buf.insert(it, entry);

    while (buf.size() > JITTER_BUFFER_MAX_DEPTH)
        buf.pop_front(); // O(1) with deque
}

void P2PMeshManager::jitterBufferDrainExpired(const std::string& userId, int64_t nowMs)
{
    (void)userId; (void)nowMs;
    // Lazy expiry — stale entries are skipped during pop
}

bool P2PMeshManager::jitterBufferPopImpl(const std::string& userId, float* outSamples,
                                      int maxSamples, int64_t nowMs)
{
    static constexpr int TARGET_DELAY_MS = 30;
    (void)nowMs;

    // No lock here — caller must hold peersMutex_
    auto bit = jitterBuffers_.find(userId);
    if (bit == jitterBuffers_.end()) return false;
    auto& buf = bit->second;
    if (buf.empty()) return false;

    const auto& first = buf.front();
    int64_t ageMs = nowMs - first.receivedAt;
    if (buf.size() < 3 && ageMs < TARGET_DELAY_MS) return false;

    size_t i = 0;
    while (i < buf.size()) {
        if (!buf[i].played) {
            buf[i].played = true;
            const uint8_t* raw = (const uint8_t*)buf[i].payload.getData();
            int rawSize = (int)buf[i].payload.getSize();

            // P1-2: Decode based on stored codec, not hardcoded PCM16
            if (buf[i].codec == CODEC_OPUS) {
                // Opus decoding path: decode to float, then convert to interleaved float outSamples
                // For now, fill with silence for Opus frames (proper Opus decode
                // requires decoder instance — the P2P mesh sends PCM16 only in current version)
                for (int s = 0; s < maxSamples; ++s)
                    outSamples[s] = 0.0f;
            } else {
                // PCM16 path (default)
                int numSamples16 = rawSize / 2;
                int toCopy = juce::jmin(numSamples16, maxSamples);
                for (int s = 0; s < toCopy; ++s) {
                    int16_t sample16 = (int16_t)((uint16_t)raw[s*2] << 8 | raw[s*2+1]);
                    outSamples[s] = sample16 / 32768.0f;
                }
                for (int s = toCopy; s < maxSamples; ++s)
                    outSamples[s] = 0.0f;
            }

            buf.erase(buf.begin() + (ptrdiff_t)i);
            return true;
        }
        ++i;
    }
    return false;
}

bool P2PMeshManager::jitterBufferPop(const std::string& userId, float* outSamples,
                                      int maxSamples, int64_t nowMs)
{
    std::lock_guard<std::mutex> lock(peersMutex_);
    return jitterBufferPopImpl(userId, outSamples, maxSamples, nowMs);
}

int P2PMeshManager::getJitterBufferDepth(const std::string& userId) const
{
    std::lock_guard<std::mutex> lock(peersMutex_);
    auto it = jitterBuffers_.find(userId);
    return it != jitterBuffers_.end() ? (int)it->second.size() : 0;
}

float P2PMeshManager::getPeerJitterMs(const std::string& userId) const
{
    std::lock_guard<std::mutex> lock(peersMutex_);
    auto it = jitterBuffers_.find(userId);
    if (it == jitterBuffers_.end() || it->second.size() < 2) return 0.0f;
    return (float)it->second.size() * 10.0f;
}

// ============================================================
// Tick — P0-6: only holds peersMutex_
// ============================================================
void P2PMeshManager::onTick()
{
    if (!running_.load()) return;

    int64_t nowMs = duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();

    // Hole-punch retry config
    static constexpr int MAX_PUNCH_RETRIES = 5;
    static constexpr int PUNCH_RETRY_INTERVAL_MS = 2000; // base interval

    std::unique_lock<std::mutex> lock(peersMutex_);
    for (auto& [uid, peer] : peers_) {

        // ---- Audio delivery for Active peers ----
        if (peer.state == PeerConnectionState::Active) {
            float samples[480 * 2];
            if (jitterBufferPopImpl(uid, samples,
                                 samplesPerPacket_ * numChannels_, nowMs)) {
                if (callback_)
                    callback_->meshAudioReceived(samples,
                                                  samplesPerPacket_,
                                                  numChannels_,
                                                  uid);
            }

            // Peer timeout check
            if ((nowMs - peer.lastHeartbeat) > PEER_TIMEOUT_MS) {
                printf("[P2PMesh] Peer timed out: %s\n", uid.c_str());
                peer.state = PeerConnectionState::Failed;
                if (callback_)
                    callback_->meshPeerStateChanged(uid, PeerConnectionState::Failed);
            }
        }

        // ---- Hole-punch retry for Connecting/Connected peers ----
        // If we have a peer candidate address and hole hasn't been confirmed,
        // retry hole punching with exponential backoff.
        if ((peer.state == PeerConnectionState::Connecting ||
             peer.state == PeerConnectionState::Connected) &&
            !peer.holePunchConfirmed &&
            peer.peerCandidateIp.isNotEmpty() &&
            peer.peerCandidatePort > 0) {

            if (peer.punchRetryCount < MAX_PUNCH_RETRIES) {
                int backoffMs = PUNCH_RETRY_INTERVAL_MS * (1 << peer.punchRetryCount);
                if (nowMs - peer.lastPunchTime >= backoffMs) {
                    printf("[P2PMesh] Retry hole punch #%d for %s\n",
                           peer.punchRetryCount + 1, uid.c_str());
                    // Release lock before punchHole (which acquires its own lock)
                    lock.unlock();
                    punchHole(uid);
                    lock.lock();
                    // Re-fetch iterator after lock reacquisition
                    auto it2 = peers_.find(uid);
                    if (it2 != peers_.end()) {
                        it2->second.punchRetryCount++;
                        it2->second.lastPunchTime = nowMs;
                    }
                }
            } else if (!peer.needsTurnFallback) {
                // All retries exhausted — mark as needing TURN fallback
                printf("[P2PMesh] Hole punch failed after %d retries for %s, "
                       "marking for TURN fallback\n",
                       MAX_PUNCH_RETRIES, uid.c_str());
                peer.needsTurnFallback = true;
                peer.state = PeerConnectionState::Failed;
                if (callback_)
                    callback_->meshPeerStateChanged(uid, PeerConnectionState::Failed);
                // TODO: P2-1 — implement TURN relay fallback via AudioRouter
            }
        }
    }
}

// ============================================================
// Audio Sending
// ============================================================
void P2PMeshManager::sendAudioBroadcast(const float* buffer, int numSamples,
                                         int numChannels, uint16_t timestamp,
                                         uint8_t codec)
{
    if (!socket_ || socket_->getBoundPort() < 0) return;

    int dataBytes = numSamples * numChannels * 2;
    int totalSize = AUDIO_PACKET_HEADER_SIZE + dataBytes;

    if (totalSize > MAX_PACKET_SIZE) {
        printf("[P2PMesh] WARNING: Packet too large %d > %d\n",
               totalSize, MAX_PACKET_SIZE);
        return;
    }

    juce::MemoryBlock packet(totalSize);
    uint8_t* p = (uint8_t*)packet.getData();

    AudioPacket* pkt = (AudioPacket*)p;
    pkt->magic     = net32(AUDIO_PACKET_MAGIC);
    pkt->sequence  = net16(sequence_.fetch_add(1));
    pkt->timestamp = net16(timestamp);
    memset(pkt->userId, 0, 32);
    memcpy(pkt->userId, localUserId_.c_str(),
           juce::jmin((int)localUserId_.size(), 31));
    pkt->codec    = codec;
    pkt->dataSize = net16((uint16_t)dataBytes);

    float* src = (float*)buffer;
    int16_t* dst = (int16_t*)(pkt->data);
    int totalSamples = numSamples * numChannels;
    for (int i = 0; i < totalSamples; ++i) {
        float clamped = juce::jlimit(-1.0f, 1.0f, src[i]);
        dst[i] = (int16_t)(clamped * 32767.0f);
    }

    broadcastToAllPeers(packet.getData(), totalSize);
}

void P2PMeshManager::sendAudioToPeer(const std::string& userId, const float* buffer,
                                     int numSamples, int numChannels,
                                     uint16_t timestamp, uint8_t codec)
{
    PeerInfo* peer = findPeer(userId);
    if (!peer || peer->state != PeerConnectionState::Active) return;

    int dataBytes = numSamples * numChannels * 2;
    int totalSize = AUDIO_PACKET_HEADER_SIZE + dataBytes;
    if (totalSize > MAX_PACKET_SIZE) return;

    juce::MemoryBlock packet(totalSize);
    uint8_t* p = (uint8_t*)packet.getData();

    AudioPacket* pkt = (AudioPacket*)p;
    pkt->magic     = net32(AUDIO_PACKET_MAGIC);
    pkt->sequence  = net16(sequence_.fetch_add(1));
    pkt->timestamp = net16(timestamp);
    memset(pkt->userId, 0, 32);
    memcpy(pkt->userId, localUserId_.c_str(),
           juce::jmin((int)localUserId_.size(), 31));
    pkt->codec    = codec;
    pkt->dataSize = net16((uint16_t)dataBytes);

    float* src = (float*)buffer;
    int16_t* dst = (int16_t*)(pkt->data);
    int totalSamples = numSamples * numChannels;
    for (int i = 0; i < totalSamples; ++i) {
        float clamped = juce::jlimit(-1.0f, 1.0f, src[i]);
        dst[i] = (int16_t)(clamped * 32767.0f);
    }

    sendToPeer(userId, packet.getData(), totalSize);
}

void P2PMeshManager::broadcastToAllPeers(const void* data, int size)
{
    std::lock_guard<std::mutex> lock(peersMutex_);
    for (auto& [uid, peer] : peers_) {
        (void)uid;
        if (peer.state == PeerConnectionState::Active && peer.ip.isNotEmpty())
            socket_->write(peer.ip, peer.port, data, size);
    }
}

void P2PMeshManager::sendToPeer(const std::string& userId, const void* data, int size)
{
    PeerInfo* peer = findPeer(userId);
    if (!peer || peer->ip.isEmpty()) return;
    if (socket_)
        socket_->write(peer->ip, peer->port, data, size);
}

// ============================================================
// NAT Detection
// ============================================================
void P2PMeshManager::detectNatTypeAsync()
{
    natDetectRunning_ = true;
    natDetectThread_ = std::thread([this]() {
        // Use ConfigManager's STUN server (falls back to stun.l.google.com:19302)
        auto& cfg = ConfigManager::instance();
        StunServerInfo server;
        if (!cfg.stunServers().empty()) {
            const std::string& entry = cfg.stunServers()[0];
            std::string rest = entry;
            if (rest.find("stun:") == 0) rest = rest.substr(5);
            size_t colon = rest.find_last_of(':');
            if (colon != std::string::npos) {
                server.host = rest.substr(0, colon);
                try { server.port = std::stoi(rest.substr(colon + 1)); } catch (...) {}
            }
        }
        if (server.host.isEmpty()) {
            server.host = "stun.l.google.com";
            server.port = 19302;
        }
        stunClient_->setServer(server);

        StunBindingResponse resp = stunClient_->bindingRequest(3000);
        if (resp.success) {
            natType_ = stunClient_->detectNatType(3000);
            mappedAddress_ = resp.mappedAddress;
            mappedPort_ = resp.mappedPort;
            printf("[P2PMesh] NAT: type=%d, mapped=%s:%d\n",
                   (int)natType_, mappedAddress_.toRawUTF8(), mappedPort_);
            if (callback_)
                callback_->meshNatTypeDetected(natType_, mappedAddress_, mappedPort_);

            // P0-1: Announce mapped address as ICE srflx candidate
            this->announceLocalCandidate();

            if (natType_ == NatType::Open)
                printf("[P2PMesh] NAT is Open — direct UDP should work\n");
        } else {
            printf("[P2PMesh] NAT detection failed (STUN unreachable)\n");
        }
        natDetectRunning_ = false;
    natDetectCond_.notify_one();
    });
}

// ============================================================
// Signaling Server Connection — P0-2
// Uses a dedicated thread with a TCP StreamingSocket
// ============================================================
void P2PMeshManager::signalingConnect()
{
    if (signalingUrl_.isEmpty() || signalingPort_ == 0) {
        printf("[P2PMesh] Signaling: no server configured\n");
        return;
    }
    signalingThread_.startThread(juce::Thread::Priority::normal);
    printf("[P2PMesh] Signaling: starting thread to %s:%d\n",
           signalingUrl_.toRawUTF8(), signalingPort_);
}

// P0-2: Enqueue a JSON message for the signaling thread to send
// over the persistent TCP connection.
void P2PMeshManager::signalingSend(const juce::String& json)
{
    if (!running_.load() || signalingUrl_.isEmpty() || signalingPort_ == 0)
        return;
    {
        std::lock_guard<std::mutex> lock(signalingQueueMutex_);
        signalingQueue_.push_back(json);
    }
    signalingQueueCond_.notify_one();
}

// Signaling thread: manages persistent TCP connection to signaling server
void P2PMeshManager::SignalingThread::run()
{
    printf("[P2PMesh] Signaling thread started\n");

    // Protocol: JSON messages separated by '\n'.
    // Outgoing: send JSON + '\n'
    // Incoming: read until '\n', parse JSON, dispatch

    while (!threadShouldExit() && man.running_.load()) {
        // Attempt TCP connection
        juce::StreamingSocket sock;
        int connected = sock.connect(man.signalingUrl_, man.signalingPort_, 3000);
        if (connected != 0) {
            printf("[P2PMesh] Signaling: connection failed (error %d), retry in 5s\n",
                   connected);
            sleep(5000);
            continue;
        }

        printf("[P2PMesh] Signaling: connected to %s:%d\n",
               man.signalingUrl_.toRawUTF8(), man.signalingPort_);

        // Send JOIN_ROOM with our ICE candidate
        juce::String localIp  = man.mappedAddress_.isNotEmpty() ? man.mappedAddress_ : "127.0.0.1";
        int localPort = man.mappedPort_ > 0 ? man.mappedPort_
                                            : (man.socket_ ? man.socket_->getBoundPort() : 0);
        juce::String joinMsg = makeJoinRoomMsg("default_room",
                                                man.localUserId_, localIp, localPort);
        {
            juce::String toSend = joinMsg + "\n";
            sock.write(toSend.toRawUTF8(), (int)strlen(toSend.toRawUTF8()));
        }

        // Read loop + queue drain
        std::string recvBuf;
        uint8_t rb[2048];

        while (!threadShouldExit() && man.running_.load()) {
            // Drain pending messages from the queue first (non-blocking send)
            {
                std::unique_lock<std::mutex> lock(man.signalingQueueMutex_);
                while (!man.signalingQueue_.empty()) {
                    juce::String msg = man.signalingQueue_.front();
                    man.signalingQueue_.pop_front();
                    lock.unlock();
                    juce::String toSend = msg + "\n";
                    sock.write(toSend.toRawUTF8(), (int)strlen(toSend.toRawUTF8()));
                    lock.lock();
                }
            }

            // Check every 100ms so we don't block threadShouldExit()
            if (sock.waitUntilReady(true, 100) == 0)
                continue; // timeout, re-check exit flag

            int n = sock.read(rb, sizeof(rb) - 1, false);
            if (n <= 0) {
                printf("[P2PMesh] Signaling: connection closed by server\n");
                break;
            }
            rb[n] = '\0';
            recvBuf.append((char*)rb, n);

            // Split by newlines
            size_t pos;
            while ((pos = recvBuf.find('\n')) != std::string::npos) {
                std::string line = recvBuf.substr(0, pos);
                recvBuf.erase(0, pos + 1);
                if (!line.empty()) {
                    juce::String msg(line.c_str());
                    man.onSignalingMessage(msg);
                }
            }
        }

        sock.close();

        if (threadShouldExit()) break;
        printf("[P2PMesh] Signaling: reconnecting in 5s...\n");
        sleep(5000);
    }

    printf("[P2PMesh] Signaling thread exited\n");
}



// ============================================================
// P0-2: Handle incoming signaling messages
// ============================================================
void P2PMeshManager::onSignalingMessage(const juce::String& msg)
{
    if (msg.isEmpty()) return;

    juce::String type = jsonFieldStr(msg, "type");
    printf("[P2PMesh] Signaling msg: type=%s\n", type.toRawUTF8());

    if (type == "PEER_LIST") {
        handleSignalingPeerList(jsonFieldStr(msg, "room_id"),
                                jsonFieldStr(msg, "peers"));
    }
    else if (type == "ICE_CANDIDATE") {
        handleSignalingIceCandidate(jsonFieldStr(msg, "from_user"),
                                    jsonFieldStr(msg, "ip"),
                                    jsonFieldInt(msg, "port"));
    }
    else if (type == "PEER_JOINED") {
        handleSignalingPeerJoined(jsonFieldStr(msg, "user_id"),
                                  jsonFieldStr(msg, "ip"),
                                  jsonFieldInt(msg, "port"));
    }
    else if (type == "PEER_LEFT") {
        removePeer(jsonFieldStr(msg, "user_id").toStdString());
    }
    else if (type == "ROOM_USERS") {
        // Generic user list: parse array of user ids
        juce::String users = jsonFieldStr(msg, "users");
        juce::StringArray arr;
        arr.addTokens(users, ",", "\"");
        for (const auto& u : arr) {
            if (u.isNotEmpty() && u != juce::String(localUserId_))
                addPeer(u.toStdString());
        }
    }
    else {
        printf("[P2PMesh] Unknown signaling message type: %s\n", type.toRawUTF8());
    }
}

// ============================================================
// P0-2: Handle PEER_LIST from signaling server
// Expected JSON: {"type":"PEER_LIST","room_id":"...",
//                 "peers":[{"user_id":"...","ip":"...","port":1234},...]}
// ============================================================
void P2PMeshManager::handleSignalingPeerList(const juce::String& roomId,
                                              const juce::String& peersJson)
{
    (void)roomId;
    if (peersJson.isEmpty()) return;

    printf("[P2PMesh] handleSignalingPeerList: %s\n", peersJson.toRawUTF8());

    // Simple array parsing: [{"user_id":"a","ip":"1.2.3.4","port":1234},...]
    // Find all {"user_id":"...","ip":"...","port":...} objects
    juce::String remaining = peersJson;
    while (true) {
        int objStart = remaining.indexOf("{");
        if (objStart < 0) break;
        remaining = remaining.substring(objStart + 1);
        int objEnd = remaining.indexOf("}");
        if (objEnd < 0) break;
        juce::String obj = remaining.substring(0, objEnd);
        remaining = remaining.substring(objEnd + 1);

        juce::String uid = jsonFieldStr(obj, "user_id");
        juce::String ip   = jsonFieldStr(obj, "ip");
        int port = jsonFieldInt(obj, "port");

        if (uid.isNotEmpty() && uid != juce::String(localUserId_) && ip.isNotEmpty() && port > 0) {
            printf("[P2PMesh] Peer from signaling: %s @ %s:%d\n",
                   uid.toRawUTF8(), ip.toRawUTF8(), port);

            // Store peer's candidate info and initiate hole punch
            bool isNew = false;
            {
                std::lock_guard<std::mutex> lock(peersMutex_);
                auto& peer = peers_[uid.toStdString()];
                if (peer.userId.empty()) {
                    peer.userId = uid.toStdString();
                    isNew = true;
                }
                peer.peerCandidateIp = ip;
                peer.peerCandidatePort = port;
                peer.punchRetryCount = 0; // reset retries on new candidate
                peer.holePunchConfirmed = false;

                if (peer.state == PeerConnectionState::Connecting ||
                    peer.state == PeerConnectionState::Disconnected) {
                    // Transition to Connected (we have their address)
                    peer.state = PeerConnectionState::Connected;
                    if (callback_)
                        callback_->meshPeerStateChanged(peer.userId,
                            PeerConnectionState::Connected);
                }
            }

            if (isNew && callback_)
                callback_->meshPeerJoined(uid.toStdString());

            // Initiate hole punch to this peer's public address
            punchHole(uid.toStdString());
        }
    }
}

// ============================================================
// P0-2: Handle ICE_CANDIDATE from signaling server
// ============================================================
void P2PMeshManager::handleSignalingIceCandidate(const juce::String& fromUser,
                                                  const juce::String& ip,
                                                  int port)
{
    if (fromUser.isEmpty() || fromUser == juce::String(localUserId_)) return;
    if (ip.isEmpty() || port <= 0) return;

    std::string uid = fromUser.toStdString();
    printf("[P2PMesh] ICE candidate from %s: %s:%d\n",
           fromUser.toRawUTF8(), ip.toRawUTF8(), port);

    // Scoped lock for peer map mutation only; punchHole acquires its own lock so
    // we must NOT call it while holding peersMutex_ (would deadlock).
    bool doPunch = false;
    bool doCallback = false;
    {
        std::lock_guard<std::mutex> lock(peersMutex_);
        auto it = peers_.find(uid);
        if (it == peers_.end()) {
            // New peer — create stub entry
            PeerInfo info;
            info.userId = uid;
            info.state = PeerConnectionState::Connecting;
            info.connectStartTime = duration_cast<milliseconds>(
                steady_clock::now().time_since_epoch()).count();
            info.lastHeartbeat = info.connectStartTime;
            info.peerCandidateIp = ip;
            info.peerCandidatePort = port;
            peers_[uid] = info;
            jitterBuffers_[uid] = std::deque<JitterBufferEntry>();
            if (callback_) callback_->meshPeerJoined(uid);
            doPunch = true;
        } else {
            // Store candidate and decide whether to hole-punch
            it->second.peerCandidateIp = ip;
            it->second.peerCandidatePort = port;
            it->second.punchRetryCount = 0; // reset retries on new candidate
            it->second.holePunchConfirmed = false;
            doPunch = (it->second.state == PeerConnectionState::Connecting ||
                       it->second.state == PeerConnectionState::Connected);
            if (doPunch) {
                it->second.state = PeerConnectionState::Connected;
                doCallback = true;
            }
        }
    } // lock released — safe to call punchHole / callback now
    if (doPunch) {
        punchHole(uid);
    }
    if (doCallback) {
        if (callback_) callback_->meshPeerStateChanged(uid, PeerConnectionState::Connected);
    }
}

// ============================================================
// P0-2: Handle PEER_JOINED from signaling server (now with IP/port)
// ============================================================
void P2PMeshManager::handleSignalingPeerJoined(const juce::String& userId,
                                               const juce::String& ip,
                                               int port)
{
    if (userId.isEmpty() || userId == juce::String(localUserId_)) return;
    std::string uid = userId.toStdString();
    printf("[P2PMesh] Peer joined via signaling: %s (%s:%d)\n",
           userId.toRawUTF8(), ip.isNotEmpty() ? ip.toRawUTF8() : "?", port);

    bool isNew = false;
    bool doPunch = false;
    {
        std::lock_guard<std::mutex> lock(peersMutex_);
        auto it = peers_.find(uid);
        if (it == peers_.end()) {
            PeerInfo info;
            info.userId = uid;
            info.state = PeerConnectionState::Connecting;
            info.connectStartTime = duration_cast<milliseconds>(
                steady_clock::now().time_since_epoch()).count();
            info.lastHeartbeat = info.connectStartTime;
            // Store peer's P2P address from signaling
            if (ip.isNotEmpty() && port > 0) {
                info.peerCandidateIp = ip;
                info.peerCandidatePort = port;
            }
            peers_[uid] = info;
            jitterBuffers_[uid] = std::deque<JitterBufferEntry>();
            isNew = true;
            doPunch = (ip.isNotEmpty() && port > 0);
        } else {
            // Update peer's address if we didn't have it before
            if (it->second.peerCandidateIp.isEmpty() && ip.isNotEmpty() && port > 0) {
                it->second.peerCandidateIp = ip;
                it->second.peerCandidatePort = port;
                doPunch = true;
            }
        }
    }

    if (isNew && callback_) callback_->meshPeerJoined(uid);
    if (doPunch) {
        punchHole(uid);
    } else {
        // No candidate yet — connectToPeer will send our candidate to signaling
        connectToPeer(uid);
    }
}
