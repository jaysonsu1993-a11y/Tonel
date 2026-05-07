using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace TonelWindows.Network;

/// <summary>
/// Transport-agnostic surface that the rest of the app talks to.
/// Mirrors macOS MixerTransport protocol. Three concrete implementations:
///
///   - MixerClient    — direct TCP :9002 + UDP :9003 to mixer host (lowest latency).
///   - WSMixerClient  — WS-direct SPA1 via tonel-ws-mixer-proxy (TCP fallback).
///   - P2PMixerClient — UDP peer-to-peer mesh (no mixer in audio path; v6.5+).
///
/// Switching is explicit and user-initiated via Settings — no auto-fallback.
/// </summary>
public interface IMixerTransport
{
    string UserIdKey { get; }    // "room_id:user_id"
    string RoomId    { get; }
    string UserId    { get; }

    /// <summary>PING/PONG round-trip over the mixer's TCP control. -1 until first PONG.</summary>
    int AudioRttMs { get; }
    /// <summary>Server-side per-user jitter target frames, parsed from MIXER_JOIN_ACK.</summary>
    int ServerJitterTargetFrames { get; }
    /// <summary>Server-side per-user jitter cap frames, parsed from MIXER_JOIN_ACK.</summary>
    int ServerJitterMaxFrames    { get; }

    Task ConnectAsync(string roomId, string userId);
    void Disconnect();

    /// <summary>Hand off one PCM16 frame to the wire. Called from capture thread — must be lock-free.</summary>
    void SendAudio(byte[] pcm, ushort timestampMs);

    /// <summary>Inbound mixer broadcasts (the N-1 mix).</summary>
    event Action<MixerPacket> Packet;

    /// <summary>MIXER_TUNE — live jitter knobs.</summary>
    void SendMixerTune(IDictionary<string, object?> knobs);

    /// <summary>PEER_GAIN — per-source mix gain map (clamped server-side to [0,2]).</summary>
    void SendPeerGain(string targetUserId, float gain);
}
