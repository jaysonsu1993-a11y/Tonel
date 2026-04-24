// MixerServerConnection.h - UDP client for the mixer server with jitter buffer
#pragma once

#include <juce_core/juce_core.h>
#include "AudioRouter.h"
#include "audio/OpusCodec.h"

// SPA1 codec enum — must match mixer_server.h
enum class SpaCodec : uint8_t {
    PCM16 = 0,
    OPUS  = 1
};

// ============================================================
// MixerServerConnection - concrete implementation of the
// MixerServerConnectionInterface defined in AudioRouter.h
// ============================================================
class MixerServerConnection : public MixerServerConnectionInterface {
public:
    explicit MixerServerConnection(int audioFrames = 240);
    ~MixerServerConnection() override;

    // MixerServerConnection interface
    void setRoomInfo(const std::string& roomId, const std::string& userId) override;
    void connect(const std::string& address, int port) override;
    void disconnect() override;
    bool isConnected() const override { return connected_.load(std::memory_order_acquire); }
    void sendAudio(const float* buffer, int numSamples, int numChannels) override;
    void setCallback(AudioRouter* router) override { router_ = router; }

    // Extra: jitter buffer polling for audio engine callback
    bool popPlayable(float* outSamples, int maxSamples) override;

    // Codec selection
    void setPreferredCodec(SpaCodec codec);
    SpaCodec activeCodec() const { return sendCodec_.load(); }

    // Jitter buffer diagnostics
    int getJitterBufferDepth() const;
    float getJitterMs() const;

private:
    void receiveThreadFunc();
    void processReceivedPacket(const uint8_t* data, int size);
    void pushJitterBuffer(uint16_t sequence, const float* samples, int frameCount);
    bool popFromJitterBuffer(float* outSamples, int maxSamples);

    // Network byte-order helpers
    static uint16_t net16(uint16_t v);
    static uint32_t net32(uint32_t v);
    static uint16_t fromNet16(const uint8_t* p);
    static uint32_t fromNet32(const uint8_t* p);

    // Network
    std::unique_ptr<juce::DatagramSocket> udpSocket_;
    std::string serverAddress_;
    int serverPort_ = 0;
    std::unique_ptr<juce::StreamingSocket> tcpSocket_;

    // Room credentials
    std::string roomId_;
    std::string userId_;

    // State
    std::atomic<bool> connected_{false};
    std::atomic<bool> running_{false};

    // Router reference
    AudioRouter* router_ = nullptr;

    // Audio format
    int audioFrames_ = 480;
    static constexpr int MIXER_CHANNELS = 2;

    // Sequence counter for outgoing packets
    std::atomic<uint16_t> sequence_{0};

    // Receive thread
    std::thread receiveThread_;

    // Jitter buffer
    struct JitterEntry {
        uint16_t sequence;
        int64_t  receivedAtMs;
        int64_t  playAtMs;
        std::vector<float> samples; // interleaved float [frames * channels]
    };
    mutable std::mutex jitterMutex_;
    std::deque<JitterEntry> jitterBuffer_;
    static constexpr int JITTER_BUFFER_MAX_DEPTH = 8;    // 80 ms look-ahead

    // Adaptive jitter buffer: tracks network jitter and adjusts latency dynamically
    // Min 10ms (1 frame), max 80ms (8 frames), default 30ms.
    std::atomic<int> currentLatencyMs_{30};
    std::deque<int64_t> arrivalIntervals_; // last 20 packet arrival intervals (ms)
    int64_t lastArrivalMs_ = 0;
    static constexpr int MIN_LATENCY_MS = 10;
    static constexpr int MAX_LATENCY_MS = 80;
    static constexpr int INITIAL_LATENCY_MS = 30;
    void updateAdaptiveLatency(int64_t nowMs);

    // SPA1 constants (must match mixer_server.h)
    static constexpr uint32_t SPA1_MAGIC = 0x53415031u;
    static constexpr int     SPA1_HEADER_SIZE = 44;
    static constexpr int     MAX_PACKET_SIZE = 2048;

    // Opus support
    std::atomic<SpaCodec> sendCodec_{ SpaCodec::PCM16 };
    std::unique_ptr<OpusEncoder> opusEncoder_;
    std::unique_ptr<OpusDecoder> opusDecoder_;
    std::vector<uint8_t> opusEncodeBuffer_;
    std::vector<float> opusDecodeBuffer_;

    // Preallocated decode buffer (avoid per-packet allocation)
    std::vector<int16_t> pcmDecodeBuffer_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MixerServerConnection)
};
