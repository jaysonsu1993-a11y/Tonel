#pragma once

#include "audio_mixer.h"
#include "AudioRecorder.h"

#include <uv.h>

#include <string>
#include <unordered_map>
#include <unordered_set>
#include <mutex>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>
#include <array>
#include <deque>

// ============================================================
// SPA1 — Simple Packet Audio format (version 1)
//
// All fields are in network byte order (big-endian).
// The header is 76 bytes fixed, followed by variable audio data.
// P1-1: userId expanded from 32 to 64 bytes for consistency.
// ============================================================

#pragma pack(push, 1)
struct SPA1Packet {
    uint32_t magic;          // 0x53415031 == "SPA1"
    uint16_t sequence;       // packet sequence number
    uint16_t timestamp;      // playback timestamp (ms)
    uint8_t  userId[64];     // null-terminated user identifier (P1-1: unified to 64)
    uint8_t  codec;           // 0 = PCM16, 1 = Opus
    uint16_t dataSize;       // size of audio data in bytes
    uint8_t  reserved;       // padding (unused)
    uint8_t  data[];         // variable-length payload
};
#pragma pack(pop)

static_assert(sizeof(SPA1Packet) == 76, "SPA1Packet header must be 76 bytes (P1-1: userId 64 bytes)");

constexpr uint32_t SPA1_MAGIC          = 0x53415031u;
constexpr uint32_t SPA1_CODEC_PCM16    = 0u;
constexpr uint32_t SPA1_CODEC_OPUS     = 1u;
constexpr uint8_t  SPA1_TYPE_AUDIO     = 0u;
constexpr uint8_t  SPA1_TYPE_HANDSHAKE = 1u;

// Opus codec state (opaque handle)
struct OpusCodecState {
    void* dec = nullptr;   // OpusDecoder*
    void* enc = nullptr;   // OpusEncoder*
    bool valid = false;
    std::vector<int16_t> pcm_decode_buf;  // decode output buffer (per-user)
    int frame_size = 0;                    // frame size for decode buffer
};

// PCM16 mono 48kHz frame size
//   20 ms per packet → 960 samples × 2 bytes = 1920 bytes
//   10 ms per packet → 480 samples × 2 bytes = 960 bytes
// The "correct" size is determined by audio_frames_ (passed at construction);
// SPA1_PCM16_FRAME_SIZE documents the max (20 ms) and is used for allocation.
constexpr size_t SPA1_PCM16_FRAME_SIZE = 1920;

// ============================================================
// MixerServer
//
// Listens on a UDP port for SPA1 audio packets and a TCP port
// for JSON control messages (MIXER_JOIN / MIXER_LEAVE).
//
// Audio packets are decoded, mixed per room, and the mixed result
// is sent back to every other participant in that room as a
// MIXED_AUDIO JSON + SPA1 binary blob.
//
// MixerServer is completely decoupled from SignalingServer —
// rooms and users are independent.
// ============================================================

class MixerServer {
public:
    // audio_frames: number of PCM frames per audio packet (default 240 for 5 ms @ 48 kHz)
    explicit MixerServer(uv_loop_t* loop, int tcp_port, int udp_port, int audio_frames = 240);
    ~MixerServer();

    void start();

    // Returns the UDP port the server is listening on (useful after bind to port 0)
    int udpPort() const { return udp_port_; }

private:
    // ── Per-user endpoint (stored in Room) ───────────────────
    // Defined before Room so unordered_map can see the complete type.
    struct UserEndpoint {
        std::string user_id;
        struct sockaddr_in addr;
        bool addr_valid = false;
        uint8_t preferred_codec = SPA1_CODEC_PCM16;  // 0=PCM16, 1=OPUS
        OpusCodecState opus;                          // opus encode state per client
        uv_stream_t* tcp_client = nullptr;            // TCP control connection for this user

        // Jitter buffer (v1.0.34). Each PCM packet is enqueued on UDP arrival
        // and dequeued exactly once per 5 ms broadcast tick before mixing.
        // The buffer absorbs network jitter at the cost of `JITTER_TARGET ×
        // 5 ms` extra end-to-end latency. v1.0.32's 0-latency PLC path
        // could not eliminate the 200 Hz click train at production WSS
        // jitter levels (~7 click events/s remained, normalized energy 0.8);
        // a small buffer is the only zero-distortion option.
        std::deque<std::vector<float>> jitter_queue;
        bool jitter_primed = false;   // false until queue first reaches jitter_target

        // Per-user jitter knobs (defaults match the v1.0.38 tuning).
        // Mutable at runtime via the MIXER_TUNE control message — see
        // handle_control_message. Per-user (rather than global) so each
        // session can pick its own latency/quality tradeoff without
        // affecting others sharing the room.
        int jitter_target    = JITTER_TARGET_DEFAULT;
        int jitter_max_depth = JITTER_MAX_DEPTH_DEFAULT;
    };

    // Jitter buffer parameters. Two independent knobs:
    //
    // - `jitter_target` — how many frames the queue must hold before the
    //   mixer starts dequeueing. Average buffer wait ≈ (target − 0.5) × 5 ms,
    //   so this is the latency cost. Steady-state queue size oscillates
    //   around target ± 1 frame (one tick between dequeue and the next
    //   enqueue).
    // - `jitter_max_depth` — the cap. When an arrival pushes queue size
    //   past this, we drop the oldest frame to keep long-run latency
    //   bounded. *Each cap-drop is 5 ms of audio gone → audible click.*
    //
    // The two are NOT interchangeable. Raising target adds latency for
    // every frame; raising cap only matters during burst arrivals.
    // Headroom = cap − target controls how many frames a burst can stuff
    // in before something has to be thrown away.
    //
    // v3.2.0 made these per-`UserEndpoint` and tunable at runtime via
    // MIXER_TUNE so the room debug panel can sweep them without a
    // redeploy. The defaults below match v1.0.38 (target=1 cap=8).
    //
    // History:
    //   v1.0.34: target=1 cap=4 — cut click rate 35× (7.2/s → 0.21/s).
    //   v1.0.35: target=2 cap=4 — *worse* than v1.0.34 in production.
    //   v1.0.36: reverted to target=1 cap=4 (= v1.0.34).
    //   v1.0.37: added the Layer 1.5 jitter sweep.
    //   v1.0.38: keep target=1, raise cap=8. plc/s drops 5–7× vs cap=4.
    static constexpr int JITTER_TARGET_DEFAULT    = 1;
    static constexpr int JITTER_MAX_DEPTH_DEFAULT = 8;
    // Hard ceilings the server will refuse to exceed (defensive — keeps a
    // tuning slider from running latency up unbounded or driving allocator
    // pressure with a 10000-frame deque).
    static constexpr int JITTER_TARGET_MAX        = 16;   // 80 ms target ceiling
    static constexpr int JITTER_MAX_DEPTH_MAX     = 64;   // 320 ms cap ceiling

    // ── Room state ──────────────────────────────────────────
    struct Room {
        std::string id;
        AudioMixer mixer;
        std::unordered_map<std::string, UserEndpoint> users;
        bool recording = false;  // true while this room is being recorded
        bool pending_mix = false; // true when new audio arrived since last mix
        uint16_t latest_timestamp = 0; // pass-through for client RTT measurement
    };

    // ── Room map access ──────────────────────────────────────
    Room* getOrCreateRoom(const std::string& room_id);
    Room* getRoom(const std::string& room_id);
    void removeRoom(const std::string& room_id);

    // ── JSON control message handling (TCP) ─────────────────
    static void  on_tcp_new_connection(uv_stream_t* server, int status);
    static void  on_tcp_alloc(uv_handle_t*, size_t suggested_size, uv_buf_t* buf);
    static void  on_tcp_read(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf);

    void handle_tcp_read(uv_stream_t* client, ssize_t nread, const uv_buf_t* buf);
    void handle_control_message(uv_stream_t* client, const std::string& msg);
    void clear_tcp_client(uv_stream_t* client);

    // ── Audio message handling (UDP) ───────────────────────
    static void  on_udp_alloc(uv_handle_t*, size_t suggested_size, uv_buf_t* buf);
    static void  on_udp_recv(uv_udp_t* handle, ssize_t nread, const uv_buf_t* buf,
                             const struct sockaddr* addr, unsigned flags);
    void handle_udp_audio(const uint8_t* data, size_t len, const struct sockaddr_in& client_addr);

    // ── Mixed audio broadcast ─────────────────────────────
    void broadcast_mixed_audio(Room* room, uint16_t sequence, uint16_t timestamp);

    // ── Per-user level broadcast (throttled ~20Hz) ──────
    void broadcast_levels(Room* room);

    // ── Timed mixing ─────────────────────────────────────
    static void on_mix_timer(uv_timer_t* handle);
    void handle_mix_timer();

    // ── JSON helpers (same SimpleJson style as signaling_server) ──
    struct SimpleJson {
        std::string type;
        std::string room_id;
        std::string user_id;
        std::string data;   // base64 audio data

        static SimpleJson parse(const std::string& str);

        static std::string make_mixed_audio(const std::string& user_id, const void* audio, size_t bytes);
        static std::string make_error(const std::string& msg);
        static std::string make_ack(const std::string& type);
        static std::string make_mixer_join_ack(int udp_port);
    };

    // ── PCM16 helpers ────────────────────────────────────────
    static void pcm16_to_float(const int16_t* src, float* dst, int count);
    static void float_to_pcm16(const float* src, int16_t* dst, int count);

    // ── Opus helpers ─────────────────────────────────────────
    static int  opus_decode_packet(UserEndpoint* ue, const uint8_t* pkt, int len, float* out);
    static int  opus_encode_packet(const float* pcm, int frame_count, int channels, uint8_t* out, int max_out, int bitrate_bps);
    static void opus_state_init(OpusCodecState* s, int sample_rate, int channels, int frame_size);
    static void opus_state_free(OpusCodecState* s);

    // ── Data ────────────────────────────────────────────────
    uv_loop_t* loop_;
    int tcp_port_;
    int udp_port_;
    int audio_frames_;   // number of PCM frames per packet (e.g. 480 = 10 ms @ 48 kHz)

    uv_tcp_t  tcp_server_;
    uv_udp_t  udp_server_;

    std::unordered_map<std::string, std::unique_ptr<Room>> rooms_;
    std::unordered_map<std::string, std::string> user_room_index_;  // user_id → room_id (O(1) lookup)
    mutable std::mutex rooms_mutex_;

    // Timed mixing: 5 ms interval, anchored to an absolute deadline so the
    // average broadcast rate stays at 200/s regardless of libuv timer slop.
    // (The default `uv_timer_start(..., 5, 5)` schedules each fire as
    // `now + 5 ms`, which compounds whatever delay the event loop took
    // to dispatch the previous fire — typically ~0.2 ms but occasionally
    // bigger. Over hours that drift accumulates to ~0.5–1 % rate offset
    // that the client has to compensate via pitch shift.)
    uv_timer_t mix_timer_;
    uint16_t   mix_sequence_       = 0;
    int        level_tick_counter_ = 0;  // throttle level broadcasts to ~20Hz
    uint64_t   mix_next_deadline_us_ = 0;  // wall-clock target for next broadcast (us, uv_hrtime base)
    static constexpr uint64_t MIX_INTERVAL_US = 5000;  // 5 ms in microseconds

    // Recording
    RecordingManager recording_manager_;
};
