// OpusCodec.h - Real-time Opus encode/decode using libopus
// Supports: 48kHz stereo, 10ms (480 samples) or 20ms (960 samples) frames
// Bitrate: configurable 64-128 kbps
#pragma once

#include <opus.h>
#include <cstdint>
#include <cstdlib>
#include <vector>
#include <memory>

// ============================================================
// OpusEncoder — float PCM → Opus bitstream
// ============================================================
class OpusEncoder {
public:
    struct Config {
        int sampleRate = 48000;
        int channels   = 2;
        int frameSize  = 480;     // samples per channel per packet (480 = 10ms @ 48kHz)
        int bitrateBps = 96000;   // 96 kbps default
        bool variablBitrate = true;
    };

    // Default Config with sensible real-time audio defaults
    OpusEncoder();
    explicit OpusEncoder(const Config& cfg);
    ~OpusEncoder();

    // Non-copyable, movable
    OpusEncoder(const OpusEncoder&) = delete;
    OpusEncoder& operator=(const OpusEncoder&) = delete;
    OpusEncoder(OpusEncoder&&);
    OpusEncoder& operator=(OpusEncoder&&);

    bool isValid() const { return enc_ != nullptr; }

    // Encode interleaved float PCM to Opus.
    // input:  frameSize * channels float samples, range [-1.0f, 1.0f]
    // output: pre-allocated buffer of at least maxOutputBytes
    // Returns bytes written; negative on error.
    int encode(const float* input, uint8_t* output, int maxOutputBytes);

    // Returns the maximum possible packet size for current config
    int maxPacketBytes() const;

    Config config() const { return cfg_; }

private:
    Config cfg_;
    OpusEncoder* enc_ = nullptr;  // opaque handle (actually OpusEncoder*)
};

// ============================================================
// OpusDecoder — Opus bitstream → float PCM
// ============================================================
class OpusDecoder {
public:
    struct Config {
        int sampleRate = 48000;
        int channels   = 2;
        int frameSize  = 480;     // samples per channel per packet
    };

    OpusDecoder();
    explicit OpusDecoder(const Config& cfg);
    ~OpusDecoder();

    // Non-copyable, movable
    OpusDecoder(const OpusDecoder&) = delete;
    OpusDecoder& operator=(const OpusDecoder&) = delete;
    OpusDecoder(OpusDecoder&&);
    OpusDecoder& operator=(OpusDecoder&&);

    bool isValid() const { return dec_ != nullptr; }

    // Decode Opus packet to interleaved float PCM.
    // input:       Opus packet bytes
    // inputBytes:  size of input packet
    // output:      pre-allocated buffer for frameSize * channels floats
    // Returns actual frames decoded; negative on error.
    int decode(const uint8_t* input, int inputBytes, float* output);

    // Get the configured frame size
    int frameSize() const { return cfg_.frameSize; }
    int channels()   const { return cfg_.channels; }

    Config config() const { return cfg_; }

private:
    Config cfg_;
    OpusDecoder* dec_ = nullptr;  // opaque handle (actually OpusDecoder*)
};
