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

    // Pitch-synchronous PLC (v1.0.33). For voiced segments the mixer
    // estimates the pitch period of the recent voice and fills missing
    // ticks by looping that single period. Because voice is locally
    // pitch-periodic, prevHistory[H-P] ≈ prevHistory[H-1] (P samples
    // earlier ≈ same phase), so the PLC fill starts essentially where
    // the previous tick ended — the 5 ms tick boundary is naturally
    // continuous, no synthetic interpolation needed.
    //
    // For unvoiced segments (whisper, room noise, silence) pitch
    // detection fails by design and PLC falls back to forward frame
    // repeat (= v1.0.32 behaviour). Worst case never regresses below
    // v1.0.32; voiced segments — where the click was loudest — improve.
    //
    // Layer 1 (1 kHz sine, 5 ms period) is *outside* the [100, 500] Hz
    // detection band so the test exercises only the unvoiced fallback
    // path — SNR/THD stay at the v1.0.30/v1.0.32 baseline.
    //
    // Tried and rejected:
    //   v1.0.31 palindrome: alternate fwd/reverse. Fixed PLC↔PLC
    //     boundary but doubled PLC↔fresh boundary jump. 8× worse on
    //     normalized click energy in user recording.
    //   v1.0.31a cross-fade: linear bridge from boundary sample to
    //     prevAudio[i]. Injected synthetic trajectory; SNR 84 → 44 dB.
    static constexpr int PLC_HISTORY_LEN  = 1200; // 25 ms @ 48 kHz — enough for 2 periods of 100 Hz
    static constexpr int PITCH_MIN        = 96;   // 500 Hz upper bound (lag in samples)
    static constexpr int PITCH_MAX        = 480;  // 100 Hz lower bound (lag in samples)
    // AMDF (Average Magnitude Difference Function) threshold relative to the
    // signal RMS. AMDF(lag) is 0 at the exact pitch period and ≈ √2·RMS at
    // a fully decorrelated lag. < 0.5 × RMS is a comfortably voiced signal.
    // Autocorrelation was tried first and rejected: spectral leakage of the
    // residual cos(2π(2i+lag)/T) sum gave ncc(non-period) values > ncc(period),
    // selecting fractional-sample lags off by 1–2 samples on a clean sine.
    // AMDF has no leakage — at the exact period the difference is bit-exact 0.
    static constexpr float PITCH_AMDF_THRESH = 0.5f;

    struct Track {
        float audio[MAX_FRAME_COUNT];          // current tick's fresh frame
        float prevHistory[PLC_HISTORY_LEN];    // sliding window of recent voice for PLC + pitch detection
        int historyLen     = 0;                // valid samples in prevHistory, ≤ PLC_HISTORY_LEN
        int frameCount     = 0;                // > 0 when fresh data is awaiting mix
        int prevLen        = 0;                // size of last fresh frame (for unvoiced fallback bounds)
        int decayCount     = 0;                // # consecutive ticks since last fresh frame, [0 .. PLC_MAX_DECAY]
        int detectedPitch  = 0;                // pitch period in samples, or 0 = unvoiced / not yet detected
        bool hasPrev       = false;            // prevHistory is non-empty and ready for PLC
        float weight       = 1.0f;
        float lastRms      = 0.0f;
    };

    std::unordered_map<std::string, Track> tracks_;

    // Internal helpers shared by mix(), mixAll(), mixExcluding().
    void accumulate(const std::string* excludeUserId, float* output, int frameCount) const;
    static void softClipBuffer(float* output, int frameCount);
    // Pitch detection on an autocorrelation peak in the [PITCH_MIN, PITCH_MAX]
    // lag range. Returns the detected period in samples, or 0 if the buffer
    // is too short / silent / unvoiced.
    static int  detectPitch(const float* hist, int historyLen);
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
        } else if (t.hasPrev && t.decayCount < PLC_MAX_DECAY && t.historyLen > 0) {
            // No fresh frame — PLC fill at a cosine-tapered gain.
            // fade(0)=1.0 (first miss = full replay), fade(PLC_MAX_DECAY-1)≈0
            // (last miss before silence). Voiced segments use pitch-period
            // repeat for natural boundary continuity; unvoiced segments
            // fall back to forward frame repeat (= v1.0.32 behaviour).
            const float fade = 0.5f * (1.0f + std::cos(static_cast<float>(M_PI) * t.decayCount / static_cast<float>(PLC_MAX_DECAY)));
            const float gw   = w * fade;
            const int   count = std::min(frameCount, t.historyLen);

            if (t.detectedPitch > 0 && t.historyLen >= t.detectedPitch) {
                // Voiced PLC: extend by looping the last pitch period.
                // phaseStart accumulates across consecutive PLC ticks so
                // the loop continues smoothly — tick N+1 picks up where
                // tick N left off, modulo the period.
                const int P = t.detectedPitch;
                const int base = t.historyLen - P;
                const int phaseStart = (t.decayCount * count) % P;
                for (int i = 0; i < count; ++i) {
                    const int p = (phaseStart + i) % P;
                    output[i] += t.prevHistory[base + p] * gw;
                }
            } else {
                // Unvoiced fallback: forward repeat of the last fresh frame.
                const int   fbCount = std::min(count, t.prevLen);
                const float* src    = t.prevHistory + t.historyLen - t.prevLen;
                for (int i = 0; i < fbCount; ++i) output[i] += src[i] * gw;
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
            // Fresh frame just mixed: append to the sliding history window
            // for PLC, then re-detect the pitch over the updated history.
            const int newLen = t.historyLen + t.frameCount;
            if (newLen <= PLC_HISTORY_LEN) {
                std::memcpy(t.prevHistory + t.historyLen, t.audio, t.frameCount * sizeof(float));
                t.historyLen = newLen;
            } else {
                // Slide oldest samples out to make room.
                const int overflow = newLen - PLC_HISTORY_LEN;
                std::memmove(t.prevHistory, t.prevHistory + overflow,
                             (PLC_HISTORY_LEN - t.frameCount) * sizeof(float));
                std::memcpy(t.prevHistory + (PLC_HISTORY_LEN - t.frameCount), t.audio,
                            t.frameCount * sizeof(float));
                t.historyLen = PLC_HISTORY_LEN;
            }
            t.prevLen    = t.frameCount;
            t.hasPrev    = true;
            t.decayCount = 0;
            t.frameCount = 0;
            t.detectedPitch = detectPitch(t.prevHistory, t.historyLen);
        } else {
            // No fresh frame this tick: advance decay (saturating at PLC_MAX_DECAY).
            if (t.decayCount < PLC_MAX_DECAY) t.decayCount++;
            t.lastRms *= 0.5f;
        }
    }
}

inline int AudioMixer::detectPitch(const float* hist, int historyLen) {
    // AMDF (Average Magnitude Difference Function) pitch detector.
    //
    //   AMDF(lag) = mean_i |hist[i] - hist[i+lag]|
    //
    // Bit-exact 0 at the exact period of any periodic signal; ≈ √(2)·MAD at
    // fully decorrelated lags. Voiced signals show a deep, narrow null at
    // their pitch period; unvoiced ones (noise / silence) stay flat.
    //
    // Need historyLen ≥ 2 × PITCH_MAX so every candidate lag has at least
    // PITCH_MAX terms. PLC_HISTORY_LEN = 1200 ≥ 2 × 480 = 960 by design.
    if (historyLen < 2 * PITCH_MAX) return 0;
    // Mean-absolute-deviation of the signal — used to normalise AMDF so the
    // threshold is scale-invariant.
    double mad = 0.0;
    for (int i = 0; i < historyLen; ++i) mad += std::fabs(static_cast<double>(hist[i]));
    mad /= historyLen;
    if (mad < 1e-6) return 0;            // silent — nothing to detect
    int    bestLag = 0;
    double bestAmdf = std::numeric_limits<double>::infinity();
    for (int lag = PITCH_MIN; lag <= PITCH_MAX; ++lag) {
        double a = 0.0;
        const int N = historyLen - lag;
        for (int i = 0; i < N; ++i) a += std::fabs(static_cast<double>(hist[i]) - hist[i + lag]);
        a /= N;
        if (a < bestAmdf) { bestAmdf = a; bestLag = lag; }
    }
    return (bestAmdf < PITCH_AMDF_THRESH * mad) ? bestLag : 0;
}

inline void AudioMixer::mix(float* output, int frameCount) {
    mixAll(output, frameCount);
    consumeAllTracks();
}
