import Foundation

/// SPA1 wire format — bit-exact match with web `audioService.ts`
/// and server `mixer_server.h` (`SPA1Packet`, 76-byte header).
///
///   offset  size  field
///     0     4     magic     u32 BE = 0x53415031 ("SPA1")
///     4     2     sequence  u16 BE
///     6     2     timestamp u16 BE  (server uses 100ms units)
///     8    64     userId    char[64] "room_id:user_id" null-terminated
///    72     1     codec     u8       (0=PCM16, 1=Opus, 0xFF=Handshake)
///    73     2     dataSize  u16 BE
///    75     1     reserved
///    76     N     payload   PCM16 LE samples for codec=0
enum SPA1 {
    static let magic: UInt32      = 0x53415031
    static let headerSize: Int    = 76
    static let userIdSize: Int    = 64
    static let maxDataSize: Int   = 1356        // matches server MAX_PAYLOAD_SIZE

    enum Codec: UInt8 {
        case pcm16     = 0
        case opus      = 1
        case handshake = 0xFF
    }

    /// Build a SPA1 packet. `userId` is the null-terminated "room_id:user_id"
    /// composite the server expects in the 64-byte slot.
    static func build(payload: Data,
                      codec: Codec,
                      sequence: UInt16,
                      timestamp: UInt16,
                      userId: String) -> Data {
        precondition(payload.count <= maxDataSize)
        var pkt = Data(count: headerSize + payload.count)
        pkt.withUnsafeMutableBytes { raw in
            let p = raw.baseAddress!.assumingMemoryBound(to: UInt8.self)
            // magic BE
            writeUInt32BE(p, 0, magic)
            // sequence BE
            writeUInt16BE(p, 4, sequence)
            // timestamp BE
            writeUInt16BE(p, 6, timestamp)
            // userId 64B null-padded
            let bytes = Array(userId.utf8.prefix(userIdSize))
            for i in 0..<userIdSize {
                p[8 + i] = i < bytes.count ? bytes[i] : 0
            }
            // codec
            p[72] = codec.rawValue
            // dataSize BE
            writeUInt16BE(p, 73, UInt16(payload.count))
            // reserved
            p[75] = 0
        }
        pkt.replaceSubrange(headerSize..<(headerSize + payload.count), with: payload)
        return pkt
    }

    struct Header {
        let sequence: UInt16
        let timestamp: UInt16
        let userId: String
        let codec: Codec?
        let dataSize: Int
    }

    /// Parse the 76-byte header. Returns nil on bad magic / oversize / short buffer.
    static func parseHeader(_ data: Data) -> Header? {
        guard data.count >= headerSize else { return nil }
        return data.withUnsafeBytes { raw -> Header? in
            let p = raw.baseAddress!.assumingMemoryBound(to: UInt8.self)
            guard readUInt32BE(p, 0) == magic else { return nil }
            let seq = readUInt16BE(p, 4)
            let ts  = readUInt16BE(p, 6)
            // userId: read up to first NUL within the 64-byte field
            var len = 0
            while len < userIdSize && p[8 + len] != 0 { len += 1 }
            let uid = String(bytes: UnsafeBufferPointer(start: p + 8, count: len),
                             encoding: .utf8) ?? ""
            let codec = Codec(rawValue: p[72])
            let dsize = Int(readUInt16BE(p, 73))
            guard dsize <= maxDataSize, data.count >= headerSize + dsize else { return nil }
            return Header(sequence: seq, timestamp: ts, userId: uid,
                          codec: codec, dataSize: dsize)
        }
    }

    /// Slice out the audio payload for a parsed packet.
    static func payload(of data: Data, header: Header) -> Data {
        data.subdata(in: headerSize..<(headerSize + header.dataSize))
    }

    // MARK: - Endian helpers (manual; UInt.bigEndian is fine but we want explicit offsets)
    @inline(__always)
    private static func writeUInt32BE(_ p: UnsafeMutablePointer<UInt8>, _ off: Int, _ v: UInt32) {
        p[off + 0] = UInt8((v >> 24) & 0xFF)
        p[off + 1] = UInt8((v >> 16) & 0xFF)
        p[off + 2] = UInt8((v >>  8) & 0xFF)
        p[off + 3] = UInt8( v        & 0xFF)
    }
    @inline(__always)
    private static func writeUInt16BE(_ p: UnsafeMutablePointer<UInt8>, _ off: Int, _ v: UInt16) {
        p[off + 0] = UInt8((v >> 8) & 0xFF)
        p[off + 1] = UInt8( v       & 0xFF)
    }
    @inline(__always)
    private static func readUInt32BE(_ p: UnsafePointer<UInt8>, _ off: Int) -> UInt32 {
        (UInt32(p[off]) << 24) | (UInt32(p[off + 1]) << 16) |
        (UInt32(p[off + 2]) <<  8) |  UInt32(p[off + 3])
    }
    @inline(__always)
    private static func readUInt16BE(_ p: UnsafePointer<UInt8>, _ off: Int) -> UInt16 {
        (UInt16(p[off]) << 8) | UInt16(p[off + 1])
    }
}

/// Wire-format audio params shared with web (`audioService.ts`).
enum AudioWire {
    static let sampleRate     = 48_000
    static let frameSamples   = 120              // 2.5 ms at 48 kHz mono
    static let frameMs        = 2.5
    static let frameBytesPCM16 = frameSamples * 2  // 240 bytes payload
}

/// PCM16 (LE) ↔ Float32 sample conversion. Decode unchanged (int16 / 32768).
/// Encode v0.1.6: tanh soft-clip with knee=0.95 instead of hard-clamp.
/// Mirrors `audio_mixer.h::softClipBuffer` on the server. Why:
///   - Hard-clamp at ±1.0 produces square-wave harmonics for any
///     instantaneous overshoot — exactly the "破音失真大小与输入音量
///     正相关" symptom the user reported on solo loopback. Server's
///     own mixer fixed the equivalent in v1.0.15 by replacing hard
///     clamp with tanh; the macOS encode path was still
///     hard-clamping every outgoing frame.
///   - Region [-0.95, 0.95] passes through linearly (byte-identical
///     to a clean linear path for normal-volume voice).
///   - Region (0.95, 1.0] is smoothly compressed by tanh — no kinks
///     in the derivative, no harmonics, zero added latency.
///   - Anything past 1.0 still saturates near ±1.0 but as a rolloff,
///     not a brickwall.
/// Asymmetric vs. web (which still hard-clamps) — strictly a quality
/// improvement on the macOS sender; other listeners hear cleaner
/// audio when this user shouts. Wire format unchanged.
enum PCM16 {
    @inline(__always) static func softClip(_ x: Float) -> Float {
        let knee: Float = 0.95
        let room: Float = 1.0 - knee  // 0.05
        if x > knee  { return knee + room * tanh((x - knee) / room) }
        if x < -knee { return -knee + room * tanh((x + knee) / room) }
        return x
    }

    static func encode(_ samples: [Float]) -> Data {
        var out = Data(count: samples.count * 2)
        out.withUnsafeMutableBytes { raw in
            let dst = raw.baseAddress!.assumingMemoryBound(to: Int16.self)
            for i in 0..<samples.count {
                // Soft-clip first (handles overshoot smoothly), then a
                // final safety clamp in case tanh produced anything
                // marginally outside [-1, 1] due to FP precision.
                let s = max(-1.0, min(1.0, softClip(samples[i])))
                dst[i] = Int16(s * 32767).littleEndian
            }
        }
        return out
    }

    static func decode(_ pcm: Data) -> [Float] {
        let count = pcm.count / 2
        var out = [Float](repeating: 0, count: count)
        pcm.withUnsafeBytes { raw in
            let src = raw.baseAddress!.assumingMemoryBound(to: Int16.self)
            for i in 0..<count {
                out[i] = Float(Int16(littleEndian: src[i])) / 32768.0
            }
        }
        return out
    }
}
