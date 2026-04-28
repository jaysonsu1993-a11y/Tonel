// mixer_server_test.cpp
// Minimal test for AudioMixer + MixerServer
//
// Usage: ./mixer_server_test
//   Runs unit tests for AudioMixer only (no network required).
//
// For integration test with the mixer server itself, run
//   ./mixer_server <tcp_port> <udp_port>
//
//   e.g.  ./mixer_server 9001 9002

#include "audio_mixer.h"
#include "mixer_server.h"

#include <cstdio>
#include <cmath>
#include <uv.h>

// ============================================================
// Unit tests for AudioMixer
// ============================================================

static bool approx(float a, float b, float eps = 1e-6f) {
    return std::fabs(a - b) < eps;
}

static int test_empty_mix() {
    AudioMixer m;
    float out[480] = {0};
    m.mix(out, 480);
    for (int i = 0; i < 480; ++i) {
        if (out[i] != 0.0f) {
            std::fprintf(stderr, "FAIL: test_empty_mix — out[%d] = %f, expected 0\n", i, out[i]);
            return 1;
        }
    }
    std::printf("PASS: test_empty_mix\n");
    return 0;
}

static int test_single_track() {
    AudioMixer m;
    float track[480];
    for (int i = 0; i < 480; ++i) track[i] = 0.5f;
    float out[480];
    m.addTrack("user1", track, 480);
    m.mix(out, 480);
    for (int i = 0; i < 480; ++i) {
        if (!approx(out[i], 0.5f)) {
            std::fprintf(stderr, "FAIL: test_single_track — out[%d] = %f, expected 0.5\n", i, out[i]);
            return 1;
        }
    }
    std::printf("PASS: test_single_track\n");
    return 0;
}

static int test_two_tracks() {
    AudioMixer m;
    float t1[480], t2[480];
    for (int i = 0; i < 480; ++i) { t1[i] = 0.3f; t2[i] = 0.4f; }
    float out[480];
    m.addTrack("user1", t1, 480);
    m.addTrack("user2", t2, 480);
    m.mix(out, 480);
    for (int i = 0; i < 480; ++i) {
        if (!approx(out[i], 0.7f)) {
            std::fprintf(stderr, "FAIL: test_two_tracks — out[%d] = %f, expected 0.7\n", i, out[i]);
            return 1;
        }
    }
    std::printf("PASS: test_two_tracks\n");
    return 0;
}

static int test_weight() {
    AudioMixer m;
    float t1[480], t2[480];
    for (int i = 0; i < 480; ++i) { t1[i] = 0.5f; t2[i] = 0.5f; }
    float out[480];
    m.addTrack("user1", t1, 480);
    m.addTrack("user2", t2, 480);
    m.setWeight("user2", 0.5f);  // half the volume of user2
    m.mix(out, 480);
    // Expected: 0.5 + 0.25 = 0.75
    for (int i = 0; i < 480; ++i) {
        if (!approx(out[i], 0.75f)) {
            std::fprintf(stderr, "FAIL: test_weight — out[%d] = %f, expected 0.75\n", i, out[i]);
            return 1;
        }
    }
    std::printf("PASS: test_weight\n");
    return 0;
}

static int test_limiter() {
    AudioMixer m;
    // 10 tracks at full volume — sum = 10.0, will be clamped to 1.0
    float track[480];
    for (int i = 0; i < 480; ++i) track[i] = 1.0f;
    float out[480];
    for (int u = 0; u < 10; ++u) {
        m.addTrack("user" + std::to_string(u), track, 480);
    }
    m.mix(out, 480);
    for (int i = 0; i < 480; ++i) {
        if (out[i] > 1.0f || out[i] < -1.0f) {
            std::fprintf(stderr, "FAIL: test_limiter — out[%d] = %f, outside [-1,1]\n", i, out[i]);
            return 1;
        }
        if (out[i] != 1.0f) {
            std::fprintf(stderr, "FAIL: test_limiter — out[%d] = %f, expected 1.0 (clamped)\n", i, out[i]);
            return 1;
        }
    }
    std::printf("PASS: test_limiter\n");
    return 0;
}

static int test_remove_track() {
    AudioMixer m;
    float t1[480], t2[480];
    for (int i = 0; i < 480; ++i) { t1[i] = 0.4f; t2[i] = 0.5f; }
    float out[480];
    m.addTrack("user1", t1, 480);
    m.addTrack("user2", t2, 480);
    m.removeTrack("user1");
    m.mix(out, 480);
    for (int i = 0; i < 480; ++i) {
        if (!approx(out[i], 0.5f)) {
            std::fprintf(stderr, "FAIL: test_remove_track — out[%d] = %f, expected 0.5\n", i, out[i]);
            return 1;
        }
    }
    std::printf("PASS: test_remove_track\n");
    return 0;
}

static int test_track_count() {
    AudioMixer m;
    float t[480] = {0};
    if (m.trackCount() != 0) { std::fprintf(stderr, "FAIL: trackCount init\n"); return 1; }
    m.addTrack("u1", t, 480);
    if (m.trackCount() != 1) { std::fprintf(stderr, "FAIL: trackCount u1\n"); return 1; }
    m.addTrack("u2", t, 480);
    if (m.trackCount() != 2) { std::fprintf(stderr, "FAIL: trackCount u2\n"); return 1; }
    m.removeTrack("u1");
    if (m.trackCount() != 1) { std::fprintf(stderr, "FAIL: trackCount after rm\n"); return 1; }
    m.removeTrack("u2");
    if (m.trackCount() != 0) { std::fprintf(stderr, "FAIL: trackCount empty\n"); return 1; }
    std::printf("PASS: test_track_count\n");
    return 0;
}

// N-1 mix invariants (v1.0.15):
//   1. mixExcluding(uid) sums every track *except* uid's.
//   2. mixExcluding does NOT consume; the caller must call consumeAllTracks.
//   3. Excluding a user that doesn't exist is a clean mix-all (no-op).
static int test_mix_excluding() {
    AudioMixer m;
    float t1[480], t2[480], t3[480];
    for (int i = 0; i < 480; ++i) { t1[i] = 0.2f; t2[i] = 0.3f; t3[i] = 0.4f; }
    m.addTrack("a", t1, 480);
    m.addTrack("b", t2, 480);
    m.addTrack("c", t3, 480);

    float out[480];
    m.mixExcluding("b", out, 480);     // expect 0.2 + 0.4 = 0.6 everywhere
    for (int i = 0; i < 480; ++i) {
        if (!approx(out[i], 0.6f)) {
            std::fprintf(stderr, "FAIL: test_mix_excluding — out[%d] = %f, expected 0.6 (a+c)\n", i, out[i]);
            return 1;
        }
    }

    // mixExcluding must NOT have consumed — a second mix still gives 0.6.
    m.mixExcluding("b", out, 480);
    if (!approx(out[0], 0.6f)) {
        std::fprintf(stderr, "FAIL: test_mix_excluding — second mix returned %f, expected 0.6 (mixExcluding consumed unexpectedly)\n", out[0]);
        return 1;
    }

    // Excluding a non-existent user is a full mix.
    m.mixExcluding("ghost", out, 480);
    if (!approx(out[0], 0.9f)) {     // 0.2 + 0.3 + 0.4 = 0.9
        std::fprintf(stderr, "FAIL: test_mix_excluding — ghost exclude gave %f, expected 0.9 (a+b+c)\n", out[0]);
        return 1;
    }

    // consumeAllTracks then mix → PLC replay at fade(0)=1.0, so the next
    // mixAll equals the previous full-amplitude mix (0.9). PLC tested in
    // detail by test_plc_*; here we just verify mixExcluding's semantics
    // remain compatible with the bookkeeping done by consumeAllTracks.
    m.consumeAllTracks();
    m.mixAll(out, 480);
    if (!approx(out[0], 0.9f)) {
        std::fprintf(stderr, "FAIL: test_mix_excluding — after consumeAllTracks, mixAll gave %f, expected 0.9 (PLC fade(0)=1.0)\n", out[0]);
        return 1;
    }
    std::printf("PASS: test_mix_excluding\n");
    return 0;
}

// Soft-clip invariants (v1.0.11):
//   1. Below the knee (|x| <= 0.85) the mix output is byte-identical to
//      the linear sum — single-talker audio MUST NOT be touched.
//   2. Above the knee, output is monotonically increasing in input and
//      stays in [-1, 1] — replaces the v1.0.10 hard clip that produced
//      square-wave distortion when two users overlapped at high volume.
static int test_soft_clip_below_knee() {
    AudioMixer m;
    float t1[480], t2[480];
    for (int i = 0; i < 480; ++i) { t1[i] = 0.4f; t2[i] = 0.4f; }   // sum = 0.8 < 0.85 knee
    float out[480];
    m.addTrack("u1", t1, 480);
    m.addTrack("u2", t2, 480);
    m.mix(out, 480);
    for (int i = 0; i < 480; ++i) {
        if (!approx(out[i], 0.8f)) {
            std::fprintf(stderr, "FAIL: test_soft_clip_below_knee — out[%d] = %f, expected 0.8 (linear pass)\n", i, out[i]);
            return 1;
        }
    }
    std::printf("PASS: test_soft_clip_below_knee\n");
    return 0;
}

static int test_soft_clip_above_knee() {
    AudioMixer m;
    float t1[480], t2[480];
    for (int i = 0; i < 480; ++i) { t1[i] = 0.6f; t2[i] = 0.6f; }   // sum = 1.2 > 1.0
    float out[480];
    m.addTrack("u1", t1, 480);
    m.addTrack("u2", t2, 480);
    m.mix(out, 480);
    for (int i = 0; i < 480; ++i) {
        // Must stay inside [-1, 1]
        if (out[i] > 1.0f || out[i] < -1.0f) {
            std::fprintf(stderr, "FAIL: test_soft_clip_above_knee — out[%d] = %f, outside [-1,1]\n", i, out[i]);
            return 1;
        }
        // Must NOT be a hard clamp at 1.0 — soft clip should produce a value strictly < 1.0
        // for finite input. (1.2 - 0.85) / 0.15 = 2.33 → tanh ≈ 0.981 → 0.85 + 0.15*0.981 ≈ 0.997
        if (out[i] >= 1.0f) {
            std::fprintf(stderr, "FAIL: test_soft_clip_above_knee — out[%d] = %f, hard-clipped at 1.0 (should be ~0.997)\n", i, out[i]);
            return 1;
        }
        if (out[i] < 0.85f) {
            std::fprintf(stderr, "FAIL: test_soft_clip_above_knee — out[%d] = %f, below knee (should be > 0.85)\n", i, out[i]);
            return 1;
        }
    }
    std::printf("PASS: test_soft_clip_above_knee\n");
    return 0;
}

// PLC (packet loss concealment) — v1.0.30. Replaces the v1.0.10
// consume-style invariant ("second mix is silence") with a bounded
// fade-out version. The original silent-second-mix design produced a
// 200 Hz click train when public-internet jitter delayed any 5 ms
// packet past its tick, because the mixer broadcast a 5 ms zero gap
// in place of the missing frame; users heard that as continuous "破音".
//
// PLC behaviour, per addTrack():
//   mix #1 (fresh)        : full amplitude
//   mix #2 .. #11 (misses): cosine-tapered replay of the previous frame,
//                           starting at fade(0)=1.0 and dropping monotonically
//                           to fade(9)≈0.024 over PLC_MAX_DECAY=10 ticks
//   mix #12+ (still missing): silent — the bounded decay protects against
//                              the 200 Hz buzz hazard the original consume
//                              invariant was guarding against.
static int test_plc_fade_after_consume() {
    AudioMixer m;
    float track[480];
    for (int i = 0; i < 480; ++i) track[i] = 0.5f;
    float out[480];

    m.addTrack("u1", track, 480);
    m.mix(out, 480);
    if (!approx(out[0], 0.5f)) {
        std::fprintf(stderr, "FAIL: test_plc_fade_after_consume — first mix = %f, expected 0.5\n", out[0]);
        return 1;
    }

    // Subsequent mixes without addTrack: PLC replay, monotonically decreasing,
    // reaching silence by mix #12 (after PLC_MAX_DECAY=10 consecutive misses).
    float prev = 0.5f;
    int silent_at = -1;
    for (int k = 1; k <= 13; ++k) {
        m.mix(out, 480);
        const float v = out[0];
        if (v > prev + 1e-5f) {
            std::fprintf(stderr, "FAIL: test_plc_fade_after_consume — mix #%d = %f, expected <= prev %f (monotonic decay)\n", k+1, v, prev);
            return 1;
        }
        if (v <= 1e-6f && silent_at < 0) silent_at = k + 1;
        prev = v;
    }
    if (silent_at < 0 || silent_at > 12) {
        std::fprintf(stderr, "FAIL: test_plc_fade_after_consume — track did not reach silence by mix #12 (silent_at=%d)\n", silent_at);
        return 1;
    }
    std::printf("PASS: test_plc_fade_after_consume (silent at mix #%d)\n", silent_at);
    return 0;
}

// PLC must reset on a fresh frame: a track mid-decay snaps back to full
// amplitude as soon as its packet arrives. Models the common public-net
// case where one packet is delayed but the stream resumes.
static int test_plc_resets_on_fresh_frame() {
    AudioMixer m;
    float t1[480], t2[480];
    for (int i = 0; i < 480; ++i) { t1[i] = 0.5f; t2[i] = 0.3f; }
    float out[480];

    m.addTrack("u1", t1, 480);
    m.mix(out, 480);             // full mix at 0.5
    m.mix(out, 480);             // PLC #1
    m.mix(out, 480);             // PLC #2
    m.mix(out, 480);             // PLC #3

    m.addTrack("u1", t2, 480);   // late-arriving fresh frame
    m.mix(out, 480);
    if (!approx(out[0], 0.3f)) {
        std::fprintf(stderr, "FAIL: test_plc_resets_on_fresh_frame — fresh frame after misses = %f, expected 0.3 (reset to full)\n", out[0]);
        return 1;
    }

    // After the fresh frame, PLC restarts from fade(0)=1.0: next mix replays
    // the *new* prev (0.3) at full amplitude, not the old 0.5.
    m.mix(out, 480);
    if (!approx(out[0], 0.3f)) {
        std::fprintf(stderr, "FAIL: test_plc_resets_on_fresh_frame — first PLC after reset = %f, expected 0.3 (fade(0)=1.0 of new prev)\n", out[0]);
        return 1;
    }
    std::printf("PASS: test_plc_resets_on_fresh_frame\n");
    return 0;
}

// PLC plays back the previous frame *forward* every miss (v1.0.32).
// History: v1.0.31 tried palindrome (alternate fwd/reverse) to make the
// PLC-tick-to-PLC-tick boundary bit-exact. It worked for that boundary
// but worsened the more common PLC-to-fresh boundary — reverse PLC ends
// at prev[0] (10 ms ago) while forward ends at prev[L-1] (5 ms ago),
// and voice changes more over 10 ms than 5 ms. Reverted to forward.
//
// This test pins the forward-direction invariant: out2[i] = ramp[i].
static int test_plc_forward_direction_on_ramp() {
    AudioMixer m;
    float ramp[480];
    for (int i = 0; i < 480; ++i) ramp[i] = 0.1f + 0.5f * (float(i) / 479.0f);
    float out1[480], out2[480];

    m.addTrack("u1", ramp, 480);
    m.mix(out1, 480);   // fresh
    m.mix(out2, 480);   // PLC miss 0

    // Forward PLC at miss 0: fade(0)=1.0, so out2[i] = ramp[i] exactly.
    for (int i = 0; i < 480; i += 64) {
        if (!approx(out2[i], ramp[i], 1e-5f)) {
            std::fprintf(stderr,
                "FAIL: out2[%d]=%f, expected ramp[%d]=%f (forward PLC, fade(0)=1.0)\n",
                i, out2[i], i, ramp[i]);
            return 1;
        }
    }
    std::printf("PASS: test_plc_forward_direction_on_ramp\n");
    return 0;
}

// Pitch-synchronous PLC (v1.0.33): on a voiced signal, the mixer
// detects the pitch period and extends by repeating that one period.
// 200 Hz sine @ 48 kHz has period exactly 240 samples — square in
// the [PITCH_MIN=96, PITCH_MAX=480] detection band — so we can verify:
//   1. The detector locks to the pitch period after enough history.
//   2. The PLC fill is the "next" period of the sine (i.e. boundary
//      is bit-exact continuous because period repeats are phase-aligned).
//   3. The PLC fill RMS matches a sine RMS (A/√2), not silence.
static int test_plc_pitch_repeat_on_sine() {
    AudioMixer m;
    constexpr int   N = 240;            // one frame = one period of 200 Hz @ 48 kHz
    constexpr float A = 0.3f;
    auto sine = [&](int idx) -> float {
        return A * std::sin(2.0f * static_cast<float>(M_PI) * 200.0f * static_cast<float>(idx) / 48000.0f);
    };

    // Build up 4 frames (960 samples) of contiguous sine = enough history for detect.
    float frame[N];
    float out[N];
    for (int f = 0; f < 4; ++f) {
        for (int i = 0; i < N; ++i) frame[i] = sine(f * N + i);
        m.addTrack("u1", frame, N);
        m.mix(out, N);
    }

    // Next mix has no fresh frame — PLC fires. With detectedPitch == 240 and
    // phaseStart=0, fill[0] = prevHistory[720] = sine(720). Since the period
    // is exactly N, sine(720) ≡ sine(960) — the "should-be" next sample.
    m.mix(out, N);

    const float expected = sine(4 * N);   // what the next sine sample would be
    if (std::fabs(out[0] - expected) > 1e-3f) {
        std::fprintf(stderr,
            "FAIL: test_plc_pitch_repeat_on_sine — out[0]=%f, expected sine(960)=%f\n",
            out[0], expected);
        return 1;
    }
    // RMS check: PLC fill should be a full-amplitude sine (not silent / not
    // attenuated to the unvoiced fallback path).
    float sumSq = 0.0f;
    for (int i = 0; i < N; ++i) sumSq += out[i] * out[i];
    const float rms = std::sqrt(sumSq / N);
    const float expRms = A / std::sqrt(2.0f);
    if (std::fabs(rms - expRms) > 0.05f) {
        std::fprintf(stderr,
            "FAIL: test_plc_pitch_repeat_on_sine — fill RMS=%f, expected sine RMS=%f\n",
            rms, expRms);
        return 1;
    }
    std::printf("PASS: test_plc_pitch_repeat_on_sine (out[0]=%f, RMS=%f)\n", out[0], rms);
    return 0;
}

// A track that has never received a frame must NOT contribute PLC noise
// (would otherwise mix uninitialized `prevAudio`). The empty-mixer path
// stays bit-exact silent.
static int test_plc_no_replay_before_first_frame() {
    AudioMixer m;
    float out[480];
    m.mix(out, 480);
    for (int i = 0; i < 480; ++i) {
        if (out[i] != 0.0f) {
            std::fprintf(stderr, "FAIL: test_plc_no_replay_before_first_frame — out[%d]=%f, expected 0\n", i, out[i]);
            return 1;
        }
    }
    std::printf("PASS: test_plc_no_replay_before_first_frame\n");
    return 0;
}

static int run_mixer_tests() {
    std::printf("\n=== AudioMixer Unit Tests ===\n");
    int failures = 0;
    failures += test_empty_mix();
    failures += test_single_track();
    failures += test_two_tracks();
    failures += test_weight();
    failures += test_limiter();
    failures += test_remove_track();
    failures += test_track_count();
    failures += test_plc_fade_after_consume();
    failures += test_plc_resets_on_fresh_frame();
    failures += test_plc_forward_direction_on_ramp();
    failures += test_plc_pitch_repeat_on_sine();
    failures += test_plc_no_replay_before_first_frame();
    failures += test_soft_clip_below_knee();
    failures += test_soft_clip_above_knee();
    failures += test_mix_excluding();
    std::printf("\n=== AudioMixer: %d test(s) failed ===\n\n", failures);
    return failures;
}

// ============================================================
// MixerServer integration runner
// ============================================================

static void run_mixer_server(int tcp_port, int udp_port) {
    uv_loop_t loop;
    uv_loop_init(&loop);

    MixerServer server(&loop, tcp_port, udp_port, 240);  // 5ms frames
    server.start();

    std::printf("MixerServer running — TCP:%d UDP:%d\n", tcp_port, udp_port);
    std::printf("Press Ctrl+C to stop.\n");

    uv_run(&loop, UV_RUN_DEFAULT);
    uv_loop_close(&loop);
}

// ============================================================
// Main
// ============================================================

int main(int argc, char* argv[]) {
    if (argc >= 2 && std::strcmp(argv[1], "--test") == 0) {
        return run_mixer_tests();
    }

    if (argc >= 3) {
        int tcp_port = std::atoi(argv[1]);
        int udp_port = std::atoi(argv[2]);
        run_mixer_server(tcp_port, udp_port);
        return 0;
    }

    std::printf("Usage:\n");
    std::printf("  %s --test           Run AudioMixer unit tests\n", argv[0]);
    std::printf("  %s <tcp_port> <udp_port>  Start mixer server\n", argv[0]);
    std::printf("\nUnit tests:\n");
    return run_mixer_tests();
}
