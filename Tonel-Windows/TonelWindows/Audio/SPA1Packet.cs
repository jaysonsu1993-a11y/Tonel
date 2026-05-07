using System;
using System.Buffers.Binary;
using System.Text;

namespace TonelWindows.Audio;

/// <summary>
/// SPA1 wire format — bit-exact match with web `audioService.ts`,
/// macOS `SPA1Packet.swift`, and server `mixer_server.h` (76-byte header).
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
/// </summary>
public static class SPA1
{
    public const uint Magic       = 0x53415031;
    public const int  HeaderSize  = 76;
    public const int  UserIdSize  = 64;
    public const int  MaxDataSize = 1356;

    public enum Codec : byte
    {
        Pcm16     = 0,
        Opus      = 1,
        /// <summary>Hole-punch packet for P2P (v6.5+); sprayed at peer's
        /// public + local addresses until a reply lands.</summary>
        PeerHello = 0xFE,
        /// <summary>Steady-state P2P keepalive (every ~5 s); also primes
        /// the rolling RTT EMA via timestamp echo.</summary>
        PeerPing  = 0xFD,
        Handshake = 0xFF,
    }

    public readonly record struct Header(
        ushort Sequence, ushort Timestamp, string UserId, Codec Codec, int DataSize);

    public static byte[] Build(ReadOnlySpan<byte> payload, Codec codec,
                               ushort sequence, ushort timestamp, string userId)
    {
        if (payload.Length > MaxDataSize) throw new ArgumentException("payload too large");
        var pkt = new byte[HeaderSize + payload.Length];
        var span = pkt.AsSpan();
        BinaryPrimitives.WriteUInt32BigEndian(span[0..],  Magic);
        BinaryPrimitives.WriteUInt16BigEndian(span[4..],  sequence);
        BinaryPrimitives.WriteUInt16BigEndian(span[6..],  timestamp);
        var uidBytes = Encoding.UTF8.GetBytes(userId);
        var copy = Math.Min(uidBytes.Length, UserIdSize);
        Array.Copy(uidBytes, 0, pkt, 8, copy);
        // remainder is already 0 (zero-init)
        pkt[72] = (byte)codec;
        BinaryPrimitives.WriteUInt16BigEndian(span[73..], (ushort)payload.Length);
        pkt[75] = 0;
        payload.CopyTo(span[HeaderSize..]);
        return pkt;
    }

    public static bool TryParseHeader(ReadOnlySpan<byte> data, out Header h)
    {
        h = default;
        if (data.Length < HeaderSize) return false;
        var magic = BinaryPrimitives.ReadUInt32BigEndian(data[0..]);
        if (magic != Magic) return false;
        var seq = BinaryPrimitives.ReadUInt16BigEndian(data[4..]);
        var ts  = BinaryPrimitives.ReadUInt16BigEndian(data[6..]);
        // userId: read up to first NUL within the 64-byte field
        int len = 0;
        while (len < UserIdSize && data[8 + len] != 0) len++;
        var uid = Encoding.UTF8.GetString(data.Slice(8, len));
        var codec = (Codec)data[72];
        var dsize = BinaryPrimitives.ReadUInt16BigEndian(data[73..]);
        if (dsize > MaxDataSize || data.Length < HeaderSize + dsize) return false;
        h = new Header(seq, ts, uid, codec, dsize);
        return true;
    }
}

/// <summary>
/// Wire-format audio params shared with all clients.
///
/// v6.0.0: frame size dropped from 120 → 32 samples (2.5 ms → 0.667 ms).
/// Wire-protocol breaking change — v6 client must talk to v6 server.
/// PCM16 payload shrinks 240 → 64 bytes; packet rate rises 400 → 1500 pps.
/// UDP handles the rate trivially; jitter cap default rose 8 → 124 frames
/// to keep ms-equivalent absorbing of bursts.
/// </summary>
public static class AudioWire
{
    public const int    SampleRate       = 48_000;
    public const int    FrameSamples     = 32;              // 0.667 ms @ 48 kHz mono — v6.0.0
    public const double FrameMs          = 32.0 / 48.0;     // 0.6667
    public const int    FrameBytesPcm16  = FrameSamples * 2;
}

/// <summary>PCM16 (LE) ↔ Float32 conversion. Web rules: enc clamp×32767, dec /32768.</summary>
public static class PCM16
{
    public static byte[] Encode(ReadOnlySpan<float> samples)
    {
        var bytes = new byte[samples.Length * 2];
        for (int i = 0; i < samples.Length; i++)
        {
            var s = samples[i];
            if (s >  1.0f) s =  1.0f;
            if (s < -1.0f) s = -1.0f;
            short v = (short)(s * 32767f);
            bytes[i * 2 + 0] = (byte)(v & 0xFF);
            bytes[i * 2 + 1] = (byte)((v >> 8) & 0xFF);
        }
        return bytes;
    }

    public static float[] Decode(ReadOnlySpan<byte> pcm)
    {
        var n = pcm.Length / 2;
        var f = new float[n];
        for (int i = 0; i < n; i++)
        {
            short v = (short)(pcm[i * 2] | (pcm[i * 2 + 1] << 8));
            f[i] = v / 32768.0f;
        }
        return f;
    }
}
