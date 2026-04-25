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
        int frameCount = 0;
        float weight = 1.0f;
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
}

inline void AudioMixer::removeTrack(const std::string& userId) {
    tracks_.erase(userId);
}

inline float AudioMixer::getTrackLevel(const std::string& userId) const {
    auto it = tracks_.find(userId);
    if (it == tracks_.end() || it->second.frameCount == 0) return 0.0f;
    const Track& t = it->second;
    float sum = 0.0f;
    for (int i = 0; i < t.frameCount; ++i) {
        sum += t.audio[i] * t.audio[i];
    }
    return std::sqrt(sum / t.frameCount);
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

    // 2. Accumulate all tracks
    for (const auto& kv : tracks_) {
        const Track& t = kv.second;
        if (t.frameCount == 0) continue;
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
    }

    // 3. Limiter — prevent clipping
    for (int i = 0; i < frameCount; ++i) {
        output[i] = std::max(-1.0f, std::min(1.0f, output[i]));
    }
}
