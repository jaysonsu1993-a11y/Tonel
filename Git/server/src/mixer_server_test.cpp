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

// Consume-style invariant: a track contributes to *exactly one* mix per
// addTrack(). A second mix() without a fresh addTrack() must produce
// silence — without this, a muted user's last 5 ms frame would be replayed
// on every 5 ms broadcast and listeners would hear it as a 200 Hz metallic
// floor noise (the v1.0.10 root cause).
static int test_consume_after_mix() {
    AudioMixer m;
    float track[480];
    for (int i = 0; i < 480; ++i) track[i] = 0.5f;
    float out1[480], out2[480];

    m.addTrack("user1", track, 480);
    m.mix(out1, 480);
    m.mix(out2, 480);

    for (int i = 0; i < 480; ++i) {
        if (!approx(out1[i], 0.5f)) {
            std::fprintf(stderr, "FAIL: test_consume_after_mix — out1[%d] = %f, expected 0.5\n", i, out1[i]);
            return 1;
        }
        if (out2[i] != 0.0f) {
            std::fprintf(stderr, "FAIL: test_consume_after_mix — out2[%d] = %f, expected 0.0 (consumed)\n", i, out2[i]);
            return 1;
        }
    }
    std::printf("PASS: test_consume_after_mix\n");
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
    failures += test_consume_after_mix();
    failures += test_soft_clip_below_knee();
    failures += test_soft_clip_above_knee();
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
