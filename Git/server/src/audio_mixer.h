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
    // Existing semantics: accumulate + soft clip + consume tracks.
    // Backward-compatible wrapper around mixAll() + consumeAllTracks().
    void mix(float* output, int frameCount);

    // Mix all tracks into output. Applies soft clip. Does NOT consume
    // tracks (the caller can call mix again, e.g. for a different
    // recipient with a different exclusion). Use consumeAllTracks()
    // explicitly when done.
    void mixAll(float* output, int frameCount);

    // Mix every track *except* the one belonging to excludeUserId. This is
    // the per-recipient N-1 mix used by the broadcast loop: each user
    // hears the sum of the *other* users, never themselves looped back.
    // Eliminates the self-echo round-trip that listeners reported as
    // "voice + distortion overlay." Applies soft clip. Does NOT consume.
    void mixExcluding(const std::string& excludeUserId, float* output, int frameCount);

    // Mark all tracks consumed: clears frameCount on tracks that had
    // fresh data this tick, decays lastRms on silent ones. Call exactly
    // once per broadcast tick, after every per-recipient mixExcluding
    // pass has finished reading the tracks.
    void consumeAllTracks();

    // Returns the number of currently active tracks
    size_t trackCount() const;

    // Returns true if the given user is in the mix
    bool hasTrack(const std::string& userId) const;

    // Compute RMS level (0.0 - 1.0) for a specific track
    float getTrackLevel(const std::string& userId) const;

private:
    static constexpr int MAX_FRAME_COUNT = 480;  // 10ms @ 48kHz (max for 5ms x2 safety)

    // PLC (packet loss concealment) decay length, in tick-sized frames.
    // When a tick fires with no fresh frame for a track, mix the previous
    // frame at a cosine-tapered gain instead of contributing silence. After
    // PLC_MAX_DECAY consecutive misses the track contributes nothing and
    // stays silent until a fresh addTrack() arrives. 10 frames @ 5 ms =
    // 50 ms — long enough for the natural envelope decay of held vowels
    // and short enough that a real silence (user muted) doesn't leak more
    // than 50 ms past the actual stop.
    static constexpr int PLC_MAX_DECAY = 10;

    // PLC fill direction toggles every miss to keep boundary samples
    // bit-exact continuous (palindrome PLC):
    //
    //   tick N-1 (fresh)      :  audio[0..L-1]     ends at audio[L-1]
    //   tick N   (PLC, miss 0):  audio[L-1..0]     starts at audio[L-1] ✓ ends at audio[0]
    //   tick N+1 (PLC, miss 1):  audio[0..L-1]     starts at audio[0]   ✓ ends at audio[L-1]
    //   tick N+2 (PLC, miss 2):  audio[L-1..0]     starts at audio[L-1] ✓ ...
    //
    // Time reversal preserves magnitude spectrum (|F{x(-t)}| = |F{x(t)}|),
    // so an automated 1 kHz sine test sees zero SNR/THD regression —
    // confirmed empirically. v1.0.31's earlier cross-fade attempt failed
    // because it bridged from the boundary sample to `prevAudio[i]`,
    // injecting a synthetic trajectory that wasn't actual signal.

    struct Track {
        float audio[MAX_FRAME_COUNT];     // preallocated fixed-size buffer
        float prevAudio[MAX_FRAME_COUNT]; // last frame mixed at full amplitude — source for PLC fill
        int frameCount = 0;               // > 0 when fresh data is awaiting mix; reset to 0 by consumeAllTracks()
        int prevLen    = 0;               // length of prevAudio when last snapshotted (for boundary lookup)
        int decayCount = 0;               // # consecutive ticks since last fresh frame, [0 .. PLC_MAX_DECAY]
        bool hasPrev   = false;           // prevAudio holds a valid frame ready for PLC fill
        float weight   = 1.0f;
        float lastRms  = 0.0f;            // updated by addTrack, decayed on silent ticks
    };

    std::unordered_map<std::string, Track> tracks_;

    // Internal helpers shared by mix(), mixAll(), mixExcluding().
    void accumulate(const std::string* excludeUserId, float* output, int frameCount) const;
    static void softClipBuffer(float* output, int frameCount);
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

inline void AudioMixer::accumulate(const std::string* excludeUserId, float* output, int frameCount) const {
    std::memset(output, 0, frameCount * sizeof(float));
    for (const auto& kv : tracks_) {
        if (excludeUserId && kv.first == *excludeUserId) continue;
        const Track& t = kv.second;
        const float w = t.weight;
        if (t.frameCount > 0) {
            // Fresh frame this tick — normal full-gain mix.
            const float* src = t.audio;
            int count = std::min(frameCount, t.frameCount);
            if (w == 1.0f) {
                for (int i = 0; i < count; ++i) output[i] += src[i];
            } else {
                for (int i = 0; i < count; ++i) output[i] += src[i] * w;
            }
        } else if (t.hasPrev && t.decayCount < PLC_MAX_DECAY && t.prevLen > 0) {
            // No fresh frame — PLC fill: replay the previous frame at a
            // cosine-tapered gain. fade(0)=1.0 (first miss = full replay),
            // fade(PLC_MAX_DECAY-1)≈0 (last miss before silence). This
            // bounded fade replaces the silent 5 ms gap that the timed
            // mixer otherwise broadcasts when a client packet is delayed
            // by public-internet jitter — that gap was the 200 Hz click
            // train v1.0.10–v1.0.29 listeners reported as "破音."
            //
            // v1.0.31 palindrome PLC: alternate forward/reverse playback
            // each miss so the sample at every tick boundary is
            // bit-exact equal across the join. With plain repeat,
            // prev[L-1] (last sample of prev tick) → prev[0] (first
            // sample of replay) is a sample-step discontinuity for any
            // signal whose start and end differ — the residual click
            // v1.0.30 cut by half but didn't eliminate.
            const float fade = 0.5f * (1.0f + std::cos(static_cast<float>(M_PI) * t.decayCount / static_cast<float>(PLC_MAX_DECAY)));
            const float gw   = w * fade;
            const float* src = t.prevAudio;
            const int  count = std::min(frameCount, t.prevLen);
            const bool reverse = (t.decayCount % 2 == 0);  // miss 0/2/4/... reverse, 1/3/5/... forward
            if (reverse) {
                const int last = t.prevLen - 1;
                for (int i = 0; i < count; ++i) output[i] += src[last - i] * gw;
            } else {
                for (int i = 0; i < count; ++i) output[i] += src[i] * gw;
            }
        }
        // else: decay exhausted or never had a frame — contribute silence.
    }
}

inline void AudioMixer::softClipBuffer(float* output, int frameCount) {
    // Soft clip — saturate above the knee instead of hard-clamping.
    //
    // The previous implementation was a hard clip (clamp to [-1, 1]),
    // which is what produced the "音量稍大失真噪音" symptom. A
    // knee-based soft clipper transparently passes anything in
    // [-kKnee, kKnee] (so normal-volume audio is byte-identical to a
    // pure linear path) and uses tanh to smoothly compress the
    // [kKnee, 1.0] region — no harmonics, no square-wave artifact,
    // zero added latency.
    //
    // v1.0.15 raised the knee from 0.85 to 0.95. At 0.85 the soft clip
    // was visible-on-the-test-bench at peak amplitudes ≥ 0.9
    // (THD ~0.06% at amp=0.9, ~0.5% at amp=0.95) — voice peaks land
    // there often enough that listeners reported volume-correlated
    // distortion. At 0.95 the same peaks pass through linearly; the
    // tanh region only activates near actual full-scale, so the
    // saturation kicks in only when it has to, not "just in case."
    constexpr float kKnee  = 0.95f;
    constexpr float kRoom  = 1.0f - kKnee;  // 0.05
    for (int i = 0; i < frameCount; ++i) {
        const float x = output[i];
        if (x > kKnee) {
            output[i] = kKnee + kRoom * std::tanh((x - kKnee) / kRoom);
        } else if (x < -kKnee) {
            output[i] = -kKnee + kRoom * std::tanh((x + kKnee) / kRoom);
        }
    }
}

inline void AudioMixer::mixAll(float* output, int frameCount) {
    accumulate(nullptr, output, frameCount);
    softClipBuffer(output, frameCount);
}

inline void AudioMixer::mixExcluding(const std::string& excludeUserId, float* output, int frameCount) {
    accumulate(&excludeUserId, output, frameCount);
    softClipBuffer(output, frameCount);
}

inline void AudioMixer::consumeAllTracks() {
    // End-of-tick bookkeeping. Two roles:
    //
    // 1. Consume-style invariant: a fresh `addTrack()` contributes to
    //    *exactly one* full-amplitude mix tick. Without this, a stalled
    //    track would replay its last 5 ms on every 5 ms broadcast —
    //    a 200 Hz repetition of a fixed 240-sample slice that listeners
    //    hear as metallic "电流声" floor noise (the v1.0.10 root cause).
    //
    // 2. PLC: a stalled track does NOT immediately go silent (which is
    //    the 200 Hz click pattern listeners reported through v1.0.29).
    //    Instead, after the one full-amplitude tick, the track keeps
    //    contributing the *previous* frame at a cosine-tapered gain for
    //    PLC_MAX_DECAY ticks (50 ms), then goes silent. The fade is
    //    computed in accumulate() from `decayCount`; here we just
    //    advance `decayCount` and snapshot fresh frames into `prevAudio`.
    //
    // The 200 Hz buzz hazard from (1) is bounded: PLC fades to zero in
    // 50 ms, so a stalled track contributes at most 10 progressively
    // quieter copies of the same frame, never an infinite loop.
    for (auto& kv : tracks_) {
        Track& t = kv.second;
        if (t.frameCount > 0) {
            // Fresh frame just mixed: snapshot it for future PLC and reset decay.
            std::memcpy(t.prevAudio, t.audio, t.frameCount * sizeof(float));
            t.prevLen    = t.frameCount;
            t.hasPrev    = true;
            t.decayCount = 0;
            t.frameCount = 0;
        } else {
            // No fresh frame this tick: advance decay (saturating at PLC_MAX_DECAY).
            if (t.decayCount < PLC_MAX_DECAY) t.decayCount++;
            t.lastRms *= 0.5f;
        }
    }
}

inline void AudioMixer::mix(float* output, int frameCount) {
    mixAll(output, frameCount);
    consumeAllTracks();
}
