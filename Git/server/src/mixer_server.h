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

// ============================================================
// SPA1 — Simple Packet Audio format (version 1)
//
// All fields are in network byte order (big-endian).
// The header is 44 bytes fixed, followed by variable audio data.
// ============================================================

#pragma pack(push, 1)
struct SPA1Packet {
    uint32_t magic;          // 0x53415031 == "SPA1"
    uint16_t sequence;       // packet sequence number
    uint16_t timestamp;      // playback timestamp (ms)
    uint8_t  userId[32];     // null-terminated user identifier
    uint8_t  codec;           // 0 = PCM16, 1 = Opus
    uint16_t dataSize;       // size of audio data in bytes
    uint8_t  reserved;       // padding to make header 44 bytes
    uint8_t  data[];         // variable-length payload
};
#pragma pack(pop)

static_assert(sizeof(SPA1Packet) == 44, "SPA1Packet header must be 44 bytes");

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
    };

    // ── Room state ──────────────────────────────────────────
    struct Room {
        std::string id;
        AudioMixer mixer;
        std::unordered_map<std::string, UserEndpoint> users;
        bool recording = false;  // true while this room is being recorded
        bool pending_mix = false; // true when new audio arrived since last mix
    };

    // ── Room map access ──────────────────────────────────────
    Room* getOrCreateRoom(const std::string& room_id);
    Room* getRoom(const std::string& room_id);
    void removeRoom(const std::string& room_id);

    // ── JSON control message handling (TCP) ─────────────────
    static void  on_tcp_new_connection(uv_stream_t* server, int status);
    static void  on_tcp_alloc(uv_handle_t*, size_t suggested_size, uv_buf_t* buf);
    static void  on_tcp_read(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf);
    static void  on_tcp_close(uv_handle_t* handle);

    void handle_tcp_read(uv_stream_t* client, ssize_t nread, const uv_buf_t* buf);
    void handle_control_message(uv_stream_t* client, const std::string& msg);

    // ── Audio message handling (UDP) ───────────────────────
    static void  on_udp_recv(uv_udp_t* handle, ssize_t nread, const uv_buf_t* buf,
                             const struct sockaddr* addr, unsigned flags);
    void handle_udp_audio(const uint8_t* data, size_t len, const struct sockaddr_in& client_addr);

    // ── Mixed audio broadcast ─────────────────────────────
    void broadcast_mixed_audio(Room* room, uint16_t sequence, uint16_t timestamp);

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

    // Timed mixing: 5ms interval for stable frame boundaries
    uv_timer_t mix_timer_;
    uint16_t mix_sequence_ = 0;

    // Recording
    RecordingManager recording_manager_;
};
