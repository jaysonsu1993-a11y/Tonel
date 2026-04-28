#pragma once

#include <string>
#include <unordered_map>
#include <vector>
#include <cstring>
#include <algorithm>
#include <cmath>

// ============================================================
// AudioMixer — multi-track audio mixer
//
// NOT internally synchronized. The caller (MixerServer) must
// hold rooms_mutex_ before calling any method. This eliminates
// redundant locking on the hot audio path.
// ============================================================

class AudioMixer {
public:
    AudioMixer() = default;
    ~AudioMixer() = default;

    // Add or update a user's audio track.
    // audio: interleaved float samples (range [-1.0f, 1.0f])
    // frameCount: number of frames (not samples) — for stereo, samples = frameCount * 2
    void addTrack(const std::string& userId, const float* audio, int frameCount);

    // Remove a user from the mix
    void removeTrack(const std::string& userId);

    // Set a user's mixing weight (0.0 = silent, 1.0 = full volume)
    void setWeight(const std::string& userId, float weight);

    // Mix all tracks into the output buffer.
    // output must have space for at least frameCount samples.
    // Each sample is the sum of all track samples multiplied by their weights,
    // clamped to [-1.0f, 1.0f] to prevent clipping.
    void mix(float* output, int frameCount);

    // Returns the number of currently active tracks
    size_t trackCount() const;

    // Returns true if the given user is in the mix
    bool hasTrack(const std::string& userId) const;

    // Compute RMS level (0.0 - 1.0) for a specific track
    float getTrackLevel(const std::string& userId) const;

private:
    static constexpr int MAX_FRAME_COUNT = 480;  // 10ms @ 48kHz (max for 5ms x2 safety)

    struct Track {
        float audio[MAX_FRAME_COUNT];  // preallocated fixed-size buffer
        int frameCount = 0;            // > 0 when fresh data is awaiting mix; reset to 0 by mix()
        float weight = 1.0f;
        float lastRms = 0.0f;          // updated by addTrack, decayed by mix() on silent ticks
    };

    std::unordered_map<std::string, Track> tracks_;
};

// ============================================================
// Inline implementation
// ============================================================

inline size_t AudioMixer::trackCount() const {
    return tracks_.size();
}

inline bool AudioMixer::hasTrack(const std::string& userId) const {
    return tracks_.find(userId) != tracks_.end();
}

inline void AudioMixer::addTrack(const std::string& userId, const float* audio, int frameCount) {
    Track& t = tracks_[userId];
    int count = std::min(frameCount, MAX_FRAME_COUNT);
    std::memcpy(t.audio, audio, count * sizeof(float));
    t.frameCount = count;
    float sum = 0.0f;
    for (int i = 0; i < count; ++i) sum += audio[i] * audio[i];
    t.lastRms = count > 0 ? std::sqrt(sum / count) : 0.0f;
}

inline void AudioMixer::removeTrack(const std::string& userId) {
    tracks_.erase(userId);
}

inline float AudioMixer::getTrackLevel(const std::string& userId) const {
    auto it = tracks_.find(userId);
    if (it == tracks_.end()) return 0.0f;
    return it->second.lastRms;
}

inline void AudioMixer::setWeight(const std::string& userId, float weight) {
    auto it = tracks_.find(userId);
    if (it != tracks_.end()) {
        it->second.weight = std::max(0.0f, std::min(weight, 2.0f)); // clamp to [0, 2]
    }
}

inline void AudioMixer::mix(float* output, int frameCount) {
    // 1. Zero the output
    std::memset(output, 0, frameCount * sizeof(float));

    // 2. Accumulate all tracks, then mark them consumed.
    //
    // Consume-style: a track contributes to *exactly one* mix per addTrack().
    // Without the post-mix `frameCount = 0`, a track that stops being
    // refreshed (user mutes, packet loss, client stalls) keeps replaying
    // its last 5 ms frame on every 5 ms broadcast — a 200 Hz periodic
    // repetition of a fixed 240-sample slice that listeners hear as a
    // metallic "电流声" floor noise. Clearing frameCount makes a missing
    // packet equal to silence rather than to "loop forever."
    for (auto& kv : tracks_) {
        Track& t = kv.second;
        if (t.frameCount == 0) {
            // Silent tick — decay the cached level so the UI meter falls
            // off when a user mutes/disconnects instead of staying stuck.
            t.lastRms *= 0.5f;
            continue;
        }
        const float w = t.weight;
        const float* src = t.audio;
        int count = std::min(frameCount, t.frameCount);
        if (w == 1.0f) {
            for (int i = 0; i < count; ++i) {
                output[i] += src[i];
            }
        } else {
            for (int i = 0; i < count; ++i) {
                output[i] += src[i] * w;
            }
        }
        t.frameCount = 0;
    }

    // 3. Soft clip — saturate above the knee instead of hard-clamping.
    //
    // The previous implementation was a hard clip (clamp to [-1, 1]),
    // which is what produced the "音量稍大失真噪音" symptom: when two
    // users spoke simultaneously the sum exceeded ±1.0 and the
    // brick-wall clip turned the waveform into a square wave full of
    // odd harmonics, audible as gritty distortion. A knee-based soft
    // clipper transparently passes anything in [-0.85, 0.85] (so
    // single-talker audio is byte-identical to before) and uses tanh
    // to smoothly compress the [0.85, 1.0] region — no harmonics, no
    // square-wave artifact. Zero added latency; tanh is only invoked
    // on samples that exceed the knee.
    constexpr float kKnee  = 0.85f;
    constexpr float kRoom  = 1.0f - kKnee;  // 0.15
    for (int i = 0; i < frameCount; ++i) {
        const float x = output[i];
        if (x > kKnee) {
            output[i] = kKnee + kRoom * std::tanh((x - kKnee) / kRoom);
        } else if (x < -kKnee) {
            output[i] = -kKnee + kRoom * std::tanh((x + kKnee) / kRoom);
        }
    }
}
