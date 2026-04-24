/**
 * @file spa1.h
 * @brief SPA1 — Simple Protocol for Audio v1 (revised)
 *
 * Lightweight binary audio protocol for real-time rehearsal sessions.
 * All multi-byte fields are in network byte order (big-endian).
 * Header is 44 bytes fixed, followed by variable audio payload.
 *
 * Magic: 0x53415031 == 'S' 'P' 'A' '1'
 *
 * ## Byte layout (44 bytes total)
 *   [0-3]   magic       uint32_t   SPA1_MAGIC
 *   [4-5]   sequence    uint16_t   Packet sequence number
 *   [6-7]   timestamp   uint16_t   Playback timestamp (ms)
 *   [8-37]  userId      char[30]   Null-terminated user identifier (max 29 chars + null)
 *   [38]    type        uint8_t    0=AUDIO, 1=HANDSHAKE
 *   [39]    codec       uint8_t    0=PCM16, 1=Opus (meaningful for AUDIO only)
 *   [40]    level       int8_t     Audio level dBFS (meaningful for AUDIO only)
 *   [41-42] dataSize    uint16_t   Payload size in bytes
 *   [43]    reserved    uint8_t    Reserved / future flags
 *
 * ## Changes from v1.0
 * - Added `type` field (offset 38): distinguishes AUDIO vs HANDSHAKE.
 * - Added `level` field (offset 40): real-time per-frame audio level.
 * - `userId` reduced 32 → 30 bytes to fund `type` and `level` additions.
 * - `dataSize` moved from offset 41 → now at 41-42 (was 41-42 in v1.0 too,
 *     but now `level` sits between `codec` and `dataSize`).
 *
 * ## Level Meter Support
 * - `level` is a server-computed signed byte: level_dBFS = (int8_t)level
 * - Range: -127 to 0 dBFS (0 = full-scale clipping threshold)
 *   level=   0 →  0 dBFS  (full scale, clipping if signal peaks here)
 *   level=  -6 → -6 dBFS  (hot but clean)
 *   level= -18 → -18 dBFS (nominal operating level)
 *   level= -36 → -36 dBFS (quiet passage)
 *   level=-127 → -127 dBFS (near-silence floor)
 * - Level > 0 indicates the signal has clipped above 0 dBFS.
 * - Level is per-frame (every packet = every 20 ms at 48 kHz).
 *
 * ## Single-Person Loopback
 * - Protocol is loopback-ready: server echoes audio back to the same userId.
 * - Client sends AUDIO → server detects single-user room → server sends
 *   mixed audio back to same userId → client plays and displays level meter.
 * - Level meter on looped audio lets the user verify their gain staging.
 * - Loopback is a server-side routing concern; the protocol carries all
 *   necessary information (userId, sequence, timestamp, level).
 */

#ifndef SPA1_H
#define SPA1_H

#include <cstdint>
#include <cstddef>

// ── Constants ────────────────────────────────────────────────────────────────

/** Magic bytes: 'S' 'P' 'A' '1' */
static constexpr uint32_t SPA1_MAGIC        = 0x53415031u;

/** Codec types */
static constexpr uint8_t SPA1_CODEC_PCM16   = 0u;
static constexpr uint8_t SPA1_CODEC_OPUS    = 1u;

/** Message types (stored in the `type` field, offset 38) */
static constexpr uint8_t SPA1_TYPE_AUDIO     = 0u;
static constexpr uint8_t SPA1_TYPE_HANDSHAKE = 1u;

/**
 * PCM16 mono 48 kHz frame size (20 ms per packet):
 *   48 000 samples/s × 0.020 s = 960 samples × 2 bytes = 1920 bytes
 * This is the max; actual packets may be smaller.
 */
static constexpr size_t SPA1_PCM16_FRAME_SIZE = 1920u;

/**
 * Audio level: signed dBFS value encoded in a single signed byte.
 *   level_dBFS = (int8_t)level
 *
 * Range -127 to 0 dBFS (0 = full-scale peak / clipping threshold):
 *   level=   0 →  0 dBFS  (clipping if signal reaches here)
 *   level=  -6 → -6 dBFS  (hot but clean)
 *   level= -18 → -18 dBFS (nominal/standard operating level)
 *   level= -36 → -36 dBFS (soft passage)
 *   level=-127 → -127 dBFS (near-silence floor)
 *
 * A value > 0 indicates the signal has clipped above 0 dBFS.
 * Server computes this from RMS/peak of the PCM frame before mixing.
 */
static constexpr int8_t  SPA1_LEVEL_CLIP    =     0;   // 0 dBFS = clipping threshold
static constexpr int8_t  SPA1_LEVEL_HOT     =     -6;   // hot but clean
static constexpr int8_t  SPA1_LEVEL_NOMINAL =    -18;   // typical operating level
static constexpr int8_t  SPA1_LEVEL_QUIET  =    -36;   // quiet passage
static constexpr int8_t  SPA1_LEVEL_SILENCE =   -127;   // near-silence floor
static constexpr int8_t  SPA1_LEVEL_MIN    =   -127;   // protocol minimum

/** Fixed header size in bytes */
static constexpr size_t SPA1_HEADER_SIZE = 44u;

// ── Packet header (44 bytes, packed) ───────────────────────────────────────

#pragma pack(push, 1)

/**
 * SPA1 packet header (flat layout, 44 bytes).
 * Cast a raw byte buffer to SPA1Packet* to parse.
 *
 * HANDSHAKE packets: `codec` and `level` fields are unused.
 * AUDIO packets: `level` carries server-computed dBFS for the current frame.
 */
struct SPA1Packet {
    uint32_t magic;          // [0-3]   SPA1_MAGIC
    uint16_t sequence;       // [4-5]   Packet sequence number
    uint16_t timestamp;      // [6-7]   Playback timestamp (ms)
    char     userId[30];     // [8-37]  Null-terminated user identifier (max 29 chars+null)
    uint8_t  type;           // [38]    0=AUDIO, 1=HANDSHAKE
    uint8_t  codec;          // [39]    0=PCM16, 1=Opus (AUDIO only)
    int8_t   level;          // [40]    Audio level in dBFS (AUDIO only, server-set)
    uint16_t dataSize;       // [41-42] Payload size in bytes
    uint8_t  reserved;       // [43]    Reserved / future flags

    /** Pointer to audio payload following the 44-byte header. */
    uint8_t* data()       { return reinterpret_cast<uint8_t*>(this) + SPA1_HEADER_SIZE; }
    const uint8_t* data() const { return reinterpret_cast<const uint8_t*>(this) + SPA1_HEADER_SIZE; }
};

#pragma pack(pop)

static_assert(sizeof(SPA1Packet) == SPA1_HEADER_SIZE, "SPA1Packet header must be exactly 44 bytes");

// ── Opcode helpers ───────────────────────────────────────────────────────────

/** Human-readable name for SPA1 message type values */
inline const char* spa1_type_name(uint8_t t) {
    return t == SPA1_TYPE_HANDSHAKE ? "HANDSHAKE" : "AUDIO";
}

/** Human-readable name for SPA1 codec values */
inline const char* spa1_codec_name(uint8_t c) {
    return c == SPA1_CODEC_OPUS ? "Opus" : "PCM16";
}

/** Check whether a magic matches SPA1_MAGIC */
inline bool spa1_is_valid(uint32_t magic) {
    return magic == SPA1_MAGIC;
}

/**
 * Encode a dBFS value into the int8_t level field.
 * Values outside [-127, 127] are clamped.
 * Returns 127 when the signal has clipped above 0 dBFS.
 */
inline int8_t spa1_level_encode(int32_t dbfs) {
    if (dbfs > 127)   return 127;   // clipped: indicate > 0 dBFS
    if (dbfs < -127)  return -127;
    return static_cast<int8_t>(dbfs);
}

/**
 * Decode the int8_t level field to a dBFS value (int16_t for convenience).
 */
inline int16_t spa1_level_decode(int8_t raw) {
    return static_cast<int16_t>(raw);
}

#endif // SPA1_H
