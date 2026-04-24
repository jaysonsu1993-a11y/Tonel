// MixerServerConnection.cpp - UDP client for mixer server
#include "MixerServerConnection.h"
#include "AudioRouter.h"
#include <chrono>
#include <cstring>

using namespace std::chrono;

// ============================================================
// Network byte order helpers
// ============================================================
uint16_t MixerServerConnection::net16(uint16_t v) {
    return (uint16_t)((v >> 8) | (v << 8));
}
uint32_t MixerServerConnection::net32(uint32_t v) {
    return ((v >> 24)) | ((v >> 8) & 0x0000FF00) |
           ((v << 8) & 0x00FF0000) | ((v << 24));
}
uint16_t MixerServerConnection::fromNet16(const uint8_t* p) {
    return ((uint16_t)p[0] << 8) | p[1];
}
uint32_t MixerServerConnection::fromNet32(const uint8_t* p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

// ============================================================
// Construction / Destruction
// ============================================================
MixerServerConnection::MixerServerConnection(int audioFrames)
    : audioFrames_(audioFrames)
{
    pcmDecodeBuffer_.resize(audioFrames * MIXER_CHANNELS);

    // Initialize Opus encoder (48kHz stereo, 10ms frames, 96kbps default)
    OpusEncoder::Config encCfg;
    encCfg.sampleRate = 48000;
    encCfg.channels   = MIXER_CHANNELS;
    encCfg.frameSize  = audioFrames;
    encCfg.bitrateBps = 96000;
    opusEncoder_ = std::make_unique<OpusEncoder>(encCfg);
    opusEncodeBuffer_.resize(opusEncoder_->maxPacketBytes());

    // Initialize Opus decoder
    OpusDecoder::Config decCfg;
    decCfg.sampleRate = 48000;
    decCfg.channels   = MIXER_CHANNELS;
    decCfg.frameSize  = audioFrames;
    opusDecoder_ = std::make_unique<OpusDecoder>(decCfg);
    opusDecodeBuffer_.resize(audioFrames * MIXER_CHANNELS);

    printf("[MixerServer] created (frames=%d, opus_encoder=%d, opus_decoder=%d)\n",
           audioFrames_, opusEncoder_->isValid(), opusDecoder_->isValid());
}

MixerServerConnection::~MixerServerConnection()
{
    disconnect();
}

// ============================================================
// Credentials (must be called before connect)
// ============================================================
void MixerServerConnection::setRoomInfo(const std::string& roomId,
                                        const std::string& userId)
{
    roomId_ = roomId;
    userId_ = userId;
}

// ============================================================
// Connect: TCP handshake then start UDP receive thread
// ============================================================
void MixerServerConnection::connect(const std::string& address, int port)
{
    if (running_.load()) {
        printf("[MixerServer] already running\n");
        return;
    }

    serverAddress_ = address;
    serverPort_ = port;

    // ── Step 1: UDP socket (bind to any port for sending/receiving) ──
    udpSocket_ = std::make_unique<juce::DatagramSocket>();
    if (!udpSocket_->bindToPort(0)) {
        printf("[MixerServer] UDP bind failed\n");
        udpSocket_.reset();
        return;
    }
    printf("[MixerServer] UDP local port: %d\n", udpSocket_->getBoundPort());

    // ── Step 2: TCP handshake to register room/user with server ──────
    tcpSocket_ = std::make_unique<juce::StreamingSocket>();
    if (!tcpSocket_->connect(address, port, 5000)) {
        printf("[MixerServer] TCP connect to %s:%d failed\n",
               address.c_str(), port);
        tcpSocket_.reset();
        udpSocket_.reset();
        return;
    }

    juce::String joinMsg = "{\"type\":\"MIXER_JOIN\","
                           "\"room_id\":\"" + juce::String(roomId_) + "\","
                           "\"user_id\":\"" + juce::String(userId_) + "\"}";
    tcpSocket_->write(joinMsg.toRawUTF8(), (int)strlen(joinMsg.toRawUTF8()));

    // Read response (read with timeout)
    char responseBuf[512];
    int n = tcpSocket_->read(responseBuf, sizeof(responseBuf) - 1, true);
    if (n > 0) {
        responseBuf[n] = '\0';
        printf("[MixerServer] TCP response: %.*s\n", n, responseBuf);
    } else {
        printf("[MixerServer] TCP handshake timeout (non-fatal)\n");
    }

    // TCP done; all further communication is UDP
    tcpSocket_.reset();

    // ── Step 3: Start receive thread ────────────────────────────────
    running_.store(true, std::memory_order_release);
    connected_.store(true, std::memory_order_release);
    receiveThread_ = std::thread(&MixerServerConnection::receiveThreadFunc, this);

    printf("[MixerServer] connected to %s:%d (room=%s user=%s)\n",
           address.c_str(), port, roomId_.c_str(), userId_.c_str());
}

void MixerServerConnection::disconnect()
{
    if (!running_.load(std::memory_order_acquire))
        return;

    running_.store(false, std::memory_order_release);
    connected_.store(false, std::memory_order_release);

    if (udpSocket_) {
        udpSocket_.reset();
    }

    if (receiveThread_.joinable())
        receiveThread_.join();

    printf("[MixerServer] disconnected\n");
}

// ============================================================
// Send audio: float → PCM16 SPA1 packet → UDP
// ============================================================
void MixerServerConnection::sendAudio(const float* buffer, int numSamples, int numChannels)
{
    if (!udpSocket_ || !connected_.load() || serverAddress_.empty())
        return;

    SpaCodec codec = sendCodec_.load();

    if (codec == SpaCodec::OPUS && opusEncoder_->isValid()) {
        // Opus path
        int encodedBytes = opusEncoder_->encode(buffer,
                                                 opusEncodeBuffer_.data(),
                                                 (int)opusEncodeBuffer_.size());
        if (encodedBytes < 0) {
            printf("[MixerServer] Opus encode error %d\n", encodedBytes);
            return;
        }
        int totalSize = SPA1_HEADER_SIZE + encodedBytes;
        if (totalSize > MAX_PACKET_SIZE) {
            printf("[MixerServer] WARNING: opus packet too large %d\n", totalSize);
            return;
        }

        juce::MemoryBlock packet(totalSize);
        uint8_t* p = (uint8_t*)packet.getData();

        // SPA1 header
        p[0] = 0x53; p[1] = 0x41; p[2] = 0x50; p[3] = 0x31; // "SPA1" magic
        uint16_t seq = sequence_.fetch_add(1);
        p[4] = (uint8_t)(seq >> 8); p[5] = (uint8_t)(seq & 0xFF);
        p[6] = 0; p[7] = 0; // timestamp (unused)
        memset(p + 8, 0, 32);
        strncpy((char*)(p + 8), userId_.c_str(), 31);
        p[40] = static_cast<uint8_t>(SpaCodec::OPUS);
        p[41] = (uint8_t)(encodedBytes >> 8); p[42] = (uint8_t)(encodedBytes & 0xFF); p[43] = 0;
        memcpy(p + SPA1_HEADER_SIZE, opusEncodeBuffer_.data(), encodedBytes);

        udpSocket_->write(serverAddress_, serverPort_, packet.getData(), totalSize);
    } else {
        // PCM16 fallback (default)
        int totalSamples = numSamples * numChannels;
        int pcmBytes = totalSamples * 2;
        int totalSize = SPA1_HEADER_SIZE + pcmBytes;

        if (totalSize > MAX_PACKET_SIZE) {
            printf("[MixerServer] WARNING: packet too large %d\n", totalSize);
            return;
        }

        juce::MemoryBlock packet(totalSize);
        uint8_t* p = (uint8_t*)packet.getData();

        // SPA1 header
        p[0] = 0x53; p[1] = 0x41; p[2] = 0x50; p[3] = 0x31; // "SPA1" magic
        uint16_t seq = sequence_.fetch_add(1);
        p[4] = (uint8_t)(seq >> 8); p[5] = (uint8_t)(seq & 0xFF);
        p[6] = 0; p[7] = 0; // timestamp (unused)
        memset(p + 8, 0, 32); // userId
        strncpy((char*)(p + 8), userId_.c_str(), 31);
        p[40] = static_cast<uint8_t>(SpaCodec::PCM16);
        p[41] = (uint8_t)(pcmBytes >> 8); p[42] = (uint8_t)(pcmBytes & 0xFF); p[43] = 0;

        // float → PCM16
        int16_t* out = (int16_t*)(p + SPA1_HEADER_SIZE);
        for (int i = 0; i < totalSamples; ++i) {
            float clamped = juce::jlimit(-1.0f, 1.0f, buffer[i]);
            out[i] = (int16_t)(clamped * 32767.0f);
        }

        udpSocket_->write(serverAddress_, serverPort_, packet.getData(), totalSize);
    }
}

// ============================================================
// Receive thread: read UDP, decode SPA1, push into jitter buffer
// ============================================================
void MixerServerConnection::receiveThreadFunc()
{
    std::vector<uint8_t> recvBuf(MAX_PACKET_SIZE);
    juce::String senderIP;
    int senderPort = 0;

    printf("[MixerServer] receive thread started\n");

    while (running_.load()) {
        // Non-blocking read with ~10ms timeout (read() returns -1 if nothing available)
        int n = udpSocket_->read(recvBuf.data(), (int)recvBuf.size(),
                                  false, senderIP, senderPort);
        if (n <= SPA1_HEADER_SIZE)
            continue;

        processReceivedPacket(recvBuf.data(), n);
    }

    printf("[MixerServer] receive thread exiting\n");
}

void MixerServerConnection::processReceivedPacket(const uint8_t* data, int size)
{
    // Validate SPA1 header
    if (size < SPA1_HEADER_SIZE)
        return;
    if (data[0] != 0x53 || data[1] != 0x41 || data[2] != 0x50 || data[3] != 0x31)
        return; // bad magic

    uint16_t dataSize = (uint16_t)((data[41] << 8) | data[42]);  // big-endian at [41-42]
    int expectedSize = SPA1_HEADER_SIZE + dataSize;
    if (size < expectedSize)
        return;

    uint16_t sequence = (uint16_t)((data[4] << 8) | data[5]);
    (void)sequence;

    uint8_t codec = data[40];
    std::vector<float> samples;
    int frameCount = 0;

    if (codec == static_cast<uint8_t>(SpaCodec::OPUS) && opusDecoder_->isValid()) {
        // Opus decode
        int decodedFrames = opusDecoder_->decode(
            data + SPA1_HEADER_SIZE, dataSize,
            opusDecodeBuffer_.data());
        if (decodedFrames < 0) {
            printf("[MixerServer] Opus decode error %d\n", decodedFrames);
            return;
        }
        frameCount = decodedFrames;
        samples.assign(opusDecodeBuffer_.data(),
                       opusDecodeBuffer_.data() + frameCount * MIXER_CHANNELS);
    } else if (codec == static_cast<uint8_t>(SpaCodec::PCM16)) {
        // PCM16 decode
        if (dataSize > (uint16_t)(MIXER_CHANNELS * audioFrames_ * 2))
            return; // sanity check
        // 添加完整性校验
        frameCount = dataSize / (MIXER_CHANNELS * 2);
        if (frameCount == 0 || dataSize % (MIXER_CHANNELS * 2) != 0)
            return; // 拒绝非完整帧
        const int16_t* pcm = (const int16_t*)(data + SPA1_HEADER_SIZE);
        samples.resize(frameCount * MIXER_CHANNELS);
        for (int i = 0; i < frameCount * MIXER_CHANNELS; ++i) {
            samples[i] = pcm[i] / 32768.0f;
        }
    } else {
        printf("[MixerServer] Unknown codec %u (size=%d)\n", codec, size);
        return;
    }

    pushJitterBuffer(sequence, samples.data(), frameCount);

    // Deliver immediately to router (jitter buffer handles timing)
    if (router_)
        router_->mixerAudioReceived(samples.data(), frameCount, MIXER_CHANNELS);
}

// ============================================================
// Jitter buffer: queue incoming frames with planned play time
// ============================================================
void MixerServerConnection::pushJitterBuffer(uint16_t, const float* samples,
                                             int frameCount)
{
    int64_t nowMs = duration_cast<milliseconds>(
        steady_clock::now().time_since_epoch()).count();

    // Update adaptive latency based on arrival interval
    updateAdaptiveLatency(nowMs);

    JitterEntry entry;
    entry.sequence = 0;
    entry.receivedAtMs = nowMs;
    entry.playAtMs = nowMs + currentLatencyMs_.load();
    entry.samples.assign(samples, samples + frameCount * MIXER_CHANNELS);

    std::lock_guard<std::mutex> lock(jitterMutex_);

    // Drop oldest if buffer is full
    while ((int)jitterBuffer_.size() >= JITTER_BUFFER_MAX_DEPTH) {
        jitterBuffer_.pop_front();
    }

    jitterBuffer_.push_back(std::move(entry));
}

void MixerServerConnection::updateAdaptiveLatency(int64_t nowMs)
{
    if (lastArrivalMs_ == 0) {
        lastArrivalMs_ = nowMs;
        return;
    }

    int64_t interval = nowMs - lastArrivalMs_;
    lastArrivalMs_ = nowMs;

    // Sanity: ignore absurd intervals (e.g. after pause/resume)
    if (interval < 0 || interval > 200) return;

    arrivalIntervals_.push_back(interval);
    if ((int)arrivalIntervals_.size() > 20)
        arrivalIntervals_.pop_front();

    if ((int)arrivalIntervals_.size() < 5)
        return; // not enough data yet

    // Compute mean and stddev
    int64_t sum = 0;
    for (auto v : arrivalIntervals_) sum += v;
    int64_t avg = sum / (int64_t)arrivalIntervals_.size();

    int64_t varSum = 0;
    for (auto v : arrivalIntervals_) {
        int64_t diff = v - avg;
        varSum += diff * diff;
    }
    int64_t stddev = static_cast<int64_t>(std::sqrt(static_cast<double>(varSum) /
                                                      arrivalIntervals_.size()));

    // Target latency = average interval + 2*stddev (covers ~95% of jitter)
    int targetLatency = static_cast<int>(avg + 2 * stddev);
    if (targetLatency < MIN_LATENCY_MS) targetLatency = MIN_LATENCY_MS;
    if (targetLatency > MAX_LATENCY_MS) targetLatency = MAX_LATENCY_MS;

    // Exponential smoothing to avoid sudden jumps
    int current = currentLatencyMs_.load();
    int smoothed = (current * 3 + targetLatency) / 4;
    currentLatencyMs_.store(smoothed);
}

bool MixerServerConnection::popFromJitterBuffer(float* outSamples, int maxSamples)
{
    int64_t nowMs = duration_cast<milliseconds>(
        steady_clock::now().time_since_epoch()).count();

    std::lock_guard<std::mutex> lock(jitterMutex_);

    if (jitterBuffer_.empty())
        return false;

    JitterEntry& front = jitterBuffer_.front();

    // Wait until play time
    if (nowMs < front.playAtMs)
        return false;

    int copyCount = juce::jmin(maxSamples, (int)front.samples.size());
    memcpy(outSamples, front.samples.data(), copyCount * sizeof(float));
    jitterBuffer_.pop_front();
    return true;
}

// ============================================================
// popPlayable — public; call from audio engine audio callback
// ============================================================
bool MixerServerConnection::popPlayable(float* outSamples, int maxSamples)
{
    return popFromJitterBuffer(outSamples, maxSamples);
}

// ============================================================
// Diagnostics
// ============================================================
int MixerServerConnection::getJitterBufferDepth() const
{
    std::lock_guard<std::mutex> lock(jitterMutex_);
    return (int)jitterBuffer_.size();
}

float MixerServerConnection::getJitterMs() const
{
    std::lock_guard<std::mutex> lock(jitterMutex_);
    if (jitterBuffer_.size() < 2)
        return 0.0f;
    return static_cast<float>(jitterBuffer_.back().receivedAtMs -
                              jitterBuffer_.front().receivedAtMs);
}

// ============================================================
// Codec selection
// ============================================================
void MixerServerConnection::setPreferredCodec(SpaCodec codec)
{
    if (codec == SpaCodec::OPUS && (!opusEncoder_->isValid() || !opusDecoder_->isValid())) {
        printf("[MixerServer] Opus not available, falling back to PCM16\n");
        codec = SpaCodec::PCM16;
    }
    SpaCodec prev = sendCodec_.exchange(codec);
    printf("[MixerServer] codec: %s → %s\n",
           (prev == SpaCodec::OPUS ? "OPUS" : "PCM16"),
           (codec == SpaCodec::OPUS ? "OPUS" : "PCM16"));
}
