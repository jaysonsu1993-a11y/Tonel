// OpusCodec.cpp - Real-time Opus encode/decode using libopus
#include "OpusCodec.h"
#include <cstring>
#include <cstdlib>
#include <algorithm>

// ============================================================
// OpusEncoder
// ============================================================
OpusEncoder::OpusEncoder() : OpusEncoder(Config()) {}

OpusEncoder::OpusEncoder(const Config& cfg) : cfg_(cfg) {
    int error;
    enc_ = ::opus_encoder_create(cfg.sampleRate, cfg.channels,
                                  OPUS_APPLICATION_RESTRICTED_LOWDELAY, &error);
    if (error != OPUS_OK || !enc_) {
        enc_ = nullptr;
        return;
    }

    ::opus_encoder_ctl(enc_, OPUS_SET_BITRATE(cfg.bitrateBps));

    if (cfg.variablBitrate) {
        ::opus_encoder_ctl(enc_, OPUS_SET_VBR(1));
        ::opus_encoder_ctl(enc_, OPUS_SET_VBR_CONSTRAINT(0));
    } else {
        ::opus_encoder_ctl(enc_, OPUS_SET_VBR(0));
        ::opus_encoder_ctl(enc_, OPUS_SET_BITRATE(cfg.bitrateBps));
    }

    ::opus_encoder_ctl(enc_, OPUS_SET_SIGNAL(OPUS_SIGNAL_MUSIC));
    ::opus_encoder_ctl(enc_, OPUS_SET_COMPLEXITY(8));
}

OpusEncoder::~OpusEncoder() {
    if (enc_) {
        ::opus_encoder_destroy(enc_);
        enc_ = nullptr;
    }
}

OpusEncoder::OpusEncoder(OpusEncoder&& o) : cfg_(o.cfg_), enc_(o.enc_) {
    o.enc_ = nullptr;
}

OpusEncoder& OpusEncoder::operator=(OpusEncoder&& o) {
    if (this != &o) {
        if (enc_) ::opus_encoder_destroy(enc_);
        cfg_ = o.cfg_;
        enc_ = o.enc_;
        o.enc_ = nullptr;
    }
    return *this;
}

int OpusEncoder::encode(const float* input, uint8_t* output, int maxOutputBytes) {
    if (!enc_) return -1;

    const int totalSamples = cfg_.frameSize * cfg_.channels;
    std::vector<int16_t> pcmBuf(totalSamples);
    for (int i = 0; i < totalSamples; ++i) {
        float clamped = std::max(-1.0f, std::min(1.0f, input[i]));
        pcmBuf[i] = static_cast<int16_t>(clamped * 32767.0f);
    }

    int n = ::opus_encode(enc_, pcmBuf.data(), cfg_.frameSize,
                           reinterpret_cast<unsigned char*>(output), maxOutputBytes);
    return n;
}

int OpusEncoder::maxPacketBytes() const {
    return 4000;
}

// ============================================================
// OpusDecoder
// ============================================================
OpusDecoder::OpusDecoder() : OpusDecoder(Config()) {}

OpusDecoder::OpusDecoder(const Config& cfg) : cfg_(cfg) {
    int error;
    dec_ = ::opus_decoder_create(cfg.sampleRate, cfg.channels, &error);
    if (error != OPUS_OK || !dec_) {
        dec_ = nullptr;
        return;
    }
}

OpusDecoder::~OpusDecoder() {
    if (dec_) {
        ::opus_decoder_destroy(dec_);
        dec_ = nullptr;
    }
}

OpusDecoder::OpusDecoder(OpusDecoder&& o) : cfg_(o.cfg_), dec_(o.dec_) {
    o.dec_ = nullptr;
}

OpusDecoder& OpusDecoder::operator=(OpusDecoder&& o) {
    if (this != &o) {
        if (dec_) ::opus_decoder_destroy(dec_);
        cfg_ = o.cfg_;
        dec_ = o.dec_;
        o.dec_ = nullptr;
    }
    return *this;
}

int OpusDecoder::decode(const uint8_t* input, int inputBytes, float* output) {
    if (!dec_) return -1;

    const int totalSamples = cfg_.frameSize * cfg_.channels;
    std::vector<int16_t> pcmBuf(totalSamples);

    int frames = ::opus_decode(dec_,
                                reinterpret_cast<const unsigned char*>(input),
                                inputBytes,
                                pcmBuf.data(),
                                cfg_.frameSize,
                                0);
    if (frames < 0) return frames;

    for (int i = 0; i < frames * cfg_.channels; ++i) {
        output[i] = pcmBuf[i] / 32768.0f;
    }
    return frames;
}
