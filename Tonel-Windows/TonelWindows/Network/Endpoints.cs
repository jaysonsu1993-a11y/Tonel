using System;
using System.Collections.Generic;

namespace TonelWindows.Network;

/// <summary>
/// Where the user has chosen to connect. v6.1.0+ Tonel supports multi-
/// server selection through Settings — each ServerLocation is a self-
/// contained bundle of the addresses needed by either transport.
/// Mirrors macOS Endpoints.ServerLocation.
/// </summary>
public sealed record ServerLocation(
    string  Id,
    string  DisplayName,
    string  MixerHost,
    ushort  MixerTcpPort,
    ushort  MixerUdpPort,
    ushort  P2PDiscoveryUdpPort,
    string? WsMixerUrl,           // ws://host:9005 (no path) — null = no WS fallback
    bool    IsAvailable)
{
    public string? WsMixerTcpUrl => WsMixerUrl == null ? null : $"{WsMixerUrl.TrimEnd('/')}/mixer-tcp";
    public string? WsMixerUdpUrl => WsMixerUrl == null ? null : $"{WsMixerUrl.TrimEnd('/')}/mixer-udp";
}

/// <summary>
/// Transport mode for the audio path.
///   - Udp — direct UDP to the central mixer (lowest latency). Default.
///   - Ws  — direct plain WS to the box's tonel-ws-mixer-proxy (TCP fallback
///           for users blocked from raw UDP). Same mixing topology as Udp.
///   - P2p — peer-to-peer mesh; each peer sends UDP directly to every
///           other peer. v6.5.0+
///
/// No auto-fallback by design — failure surfaces and the user picks another.
/// </summary>
public enum TransportMode
{
    Udp,
    Ws,
    P2p,
}

public static class TransportModeExtensions
{
    public static string ToWireString(this TransportMode m) => m switch
    {
        TransportMode.Udp => "udp",
        TransportMode.Ws  => "ws",
        TransportMode.P2p => "p2p",
        _ => "udp",
    };

    public static TransportMode? ParseWire(string? s) => s switch
    {
        "udp" => TransportMode.Udp,
        "ws"  => TransportMode.Ws,
        "p2p" => TransportMode.P2p,
        _     => null,
    };

    public static string ToDisplayName(this TransportMode m) => m switch
    {
        TransportMode.Udp => "UDP（低延迟）",
        TransportMode.Ws  => "WS（兼容）",
        TransportMode.P2p => "P2P（直连）",
        _ => "UDP",
    };
}

/// <summary>
/// All network endpoints in one place. Pre-v6.1.0 this was a flat
/// singleton with hard-coded Aliyun hosts; v6.1.0 introduced
/// ServerLocation so users can pick a region.
/// </summary>
public static class Endpoints
{
    /// <summary>广州1 = Aliyun (8.163.21.207). The only fully-online location.</summary>
    public static readonly ServerLocation Guangzhou1 = new(
        Id: "guangzhou1",
        DisplayName: "广州1",
        MixerHost: "8.163.21.207",
        MixerTcpPort: 9002,
        MixerUdpPort: 9003,
        P2PDiscoveryUdpPort: 9001,
        WsMixerUrl: "ws://8.163.21.207:9005",
        IsAvailable: true);

    /// <summary>
    /// 广州2 = 酷番云 (42.240.163.172). Banned by IDC for hosting a foreign
    /// TLD without ICP filing — TCP RST'd from outside. Greyed-out
    /// placeholder until that's resolved.
    /// </summary>
    public static readonly ServerLocation Guangzhou2 = new(
        Id: "guangzhou2",
        DisplayName: "广州2",
        MixerHost: "42.240.163.172",
        MixerTcpPort: 9002,
        MixerUdpPort: 9003,
        P2PDiscoveryUdpPort: 9001,
        WsMixerUrl: "ws://42.240.163.172:9005",
        IsAvailable: false);

    public static readonly IReadOnlyList<ServerLocation> AllServers = new[] { Guangzhou1, Guangzhou2 };

    public static ServerLocation ServerById(string id)
    {
        foreach (var s in AllServers) if (s.Id == id) return s;
        return DefaultServer;
    }

    public static readonly ServerLocation DefaultServer = Guangzhou1;
    public static readonly TransportMode DefaultTransport = TransportMode.Udp;

    // Persisted-selection keys
    public const string ServerIdKey      = "tonel.server.id";
    public const string TransportModeKey = "tonel.transport.mode";

    // Signaling / user service (location-independent)
    public const string SignalingUrl  = "wss://api.tonel.io/signaling";
    public const string UserServiceBase = "https://api.tonel.io";
}
