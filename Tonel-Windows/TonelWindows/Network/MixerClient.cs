using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using TonelWindows.App;
using TonelWindows.Audio;

namespace TonelWindows.Network;

public readonly record struct MixerPacket(
    string UserId,        // "room_id:user_id" — caller strips room prefix
    ushort Sequence,
    ushort Timestamp,
    byte[] Pcm);          // raw PCM16 LE bytes (240 bytes for a 2.5 ms frame)

public enum MixerState { Idle, Connecting, Connected, Failed, Disconnected }

/// <summary>
/// Mixer transport — TCP control + UDP audio direct to a chosen server box.
/// Mirrors macOS MixerClient.swift; uses raw Sockets so no system proxy
/// (Clash/SS) ever inserts itself in the audio path.
/// </summary>
public sealed class MixerClient : IMixerTransport
{
    /// <summary>Where this client is connecting to. v6.1.0+ injected at ctor.</summary>
    public ServerLocation ServerLocation { get; }

    public MixerClient(ServerLocation? serverLocation = null)
    {
        ServerLocation = serverLocation ?? Endpoints.DefaultServer;
        _udpPort = ServerLocation.MixerUdpPort;
    }

    public event Action<MixerPacket>? Packet;
    event Action<MixerPacket> IMixerTransport.Packet
    {
        add    { Packet += value; }
        remove { Packet -= value; }
    }

    public MixerState State { get; private set; } = MixerState.Idle;
    public string RoomId { get; private set; } = "";
    public string UserId { get; private set; } = "";
    public string UserIdKey { get; private set; } = "";   // "room_id:user_id" — what goes in SPA1 userId slot

    private Socket? _tcp;
    private Socket? _udp;
    private IPEndPoint? _udpRemote;
    private Thread? _tcpReadThread;
    private Thread? _udpReadThread;
    private ushort _udpPort;
    private ushort _sequence;

    // Audio RTT (mixer TCP PING/PONG)
    public int AudioRttMs { get; private set; } = -1;
    public int ServerJitterTargetFrames { get; private set; } = 2;
    public int ServerJitterMaxFrames { get; private set; } = 8;

    private long _pingSentAtTicks;
    private Timer? _pingTimer;

    public async Task ConnectAsync(string roomId, string userId)
    {
        RoomId = roomId; UserId = userId;
        UserIdKey = $"{roomId}:{userId}";
        State = MixerState.Connecting;
        AppLog.Log($"[Mixer] connect → tcp {ServerLocation.MixerHost}:{ServerLocation.MixerTcpPort} room={roomId} user={userId}");

        await OpenTcpAsync();
        AppLog.Log("[Mixer] TCP ready, sending MIXER_JOIN");
        await SendJoinAndAwaitAckAsync();
        AppLog.Log($"[Mixer] MIXER_JOIN_ACK received, udpPort={_udpPort}");
        OpenUdp();
        AppLog.Log($"[Mixer] UDP socket open → {ServerLocation.MixerHost}:{_udpPort}");
        SendHandshake();
        StartUdpReceive();
        StartTcpRead();
        StartPing();
        State = MixerState.Connected;
        AppLog.Log("[Mixer] connected ✅");
    }

    public void Disconnect()
    {
        if (!string.IsNullOrEmpty(RoomId))
            SendJson(new Dictionary<string, object?>
            {
                ["type"] = "MIXER_LEAVE",
                ["room_id"] = RoomId,
                ["user_id"] = UserId,
            });
        StopPing();
        try { _tcp?.Shutdown(SocketShutdown.Both); } catch { }
        try { _tcp?.Close(); } catch { }
        _tcp = null;
        try { _udp?.Close(); } catch { }
        _udp = null;
        State = MixerState.Disconnected;
    }

    private async Task OpenTcpAsync()
    {
        var sock = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp)
        {
            NoDelay = true,
            ReceiveTimeout = 0,
            SendTimeout = 0,
        };
        var ip = IPAddress.Parse(ServerLocation.MixerHost);
        var ep = new IPEndPoint(ip, ServerLocation.MixerTcpPort);
        using var cts = new CancellationTokenSource(5000);
        try { await sock.ConnectAsync(ep, cts.Token); }
        catch (OperationCanceledException) { sock.Dispose(); throw new IOException("connect timeout"); }
        _tcp = sock;
        AppLog.Log("[Mixer] TCP connected (POSIX)");
    }

    private async Task SendJoinAndAwaitAckAsync()
    {
        var sock = _tcp ?? throw new InvalidOperationException("no tcp");
        var join = $"{{\"type\":\"MIXER_JOIN\",\"room_id\":\"{RoomId}\",\"user_id\":\"{UserId}\"}}\n";
        sock.Send(Encoding.UTF8.GetBytes(join));

        var deadline = DateTime.UtcNow.AddSeconds(8);
        var buf = new byte[4096];
        var accum = new StringBuilder();
        while (DateTime.UtcNow < deadline && !accum.ToString().Contains('\n'))
        {
            sock.Poll(50_000, SelectMode.SelectRead);
            if (sock.Available > 0)
            {
                var n = sock.Receive(buf);
                if (n > 0) accum.Append(Encoding.UTF8.GetString(buf, 0, n));
            }
            else
            {
                await Task.Delay(10);
            }
        }
        var line = accum.ToString().Split('\n')[0];
        if (string.IsNullOrEmpty(line)) throw new IOException("ACK timeout");
        AppLog.Log($"[Mixer] ACK: {line}");
        if (line.Contains("\"error\"")) throw new IOException(line);

        _udpPort = ParseIntField(line, "udp_port", _udpPort) is var up && up > 0 ? (ushort)up : _udpPort;
        var jt = ParseIntField(line, "jitter_target", ServerJitterTargetFrames);
        if (jt > 0) ServerJitterTargetFrames = jt;
        var jm = ParseIntField(line, "jitter_max_depth", ServerJitterMaxFrames);
        if (jm > 0) ServerJitterMaxFrames = jm;
    }

    private static int ParseIntField(string s, string name, int fallback)
    {
        var key = $"\"{name}\":";
        var i = s.IndexOf(key, StringComparison.Ordinal);
        if (i < 0) return fallback;
        i += key.Length;
        var start = i;
        while (i < s.Length && (char.IsDigit(s[i]) || (i == start && s[i] == '-'))) i++;
        return int.TryParse(s.AsSpan(start, i - start), out var v) ? v : fallback;
    }

    private void StartTcpRead()
    {
        var t = new Thread(() =>
        {
            var sock = _tcp;
            if (sock == null) return;
            var buf = new byte[8192];
            try
            {
                while (sock.Connected)
                {
                    int n;
                    try { n = sock.Receive(buf); }
                    catch (SocketException) { break; }
                    if (n <= 0) break;
                    var recvTicks = DateTime.UtcNow.Ticks;
                    var s = Encoding.UTF8.GetString(buf, 0, n);
                    HandleTcpChunk(s, recvTicks);
                }
            }
            catch (Exception e) { AppLog.Log($"[Mixer] TCP read err: {e.Message}"); }
            State = MixerState.Disconnected;
        }) { IsBackground = true, Name = "tonel.tcpread" };
        t.Start();
        _tcpReadThread = t;
    }

    private void HandleTcpChunk(string s, long recvTicks)
    {
        if (s.Contains("\"PONG\""))
        {
            var sent = Interlocked.Exchange(ref _pingSentAtTicks, 0);
            if (sent > 0)
                AudioRttMs = (int)((recvTicks - sent) / TimeSpan.TicksPerMillisecond);
        }
        // LEVELS broadcasts are ignored — peer meters come from decoded PCM.
    }

    private void StartPing()
    {
        StopPing();
        _pingTimer = new Timer(_ => SendPing(), null, 0, 3000);
    }

    private void StopPing()
    {
        var t = _pingTimer; _pingTimer = null;
        t?.Dispose();
        Interlocked.Exchange(ref _pingSentAtTicks, 0);
    }

    private void SendPing()
    {
        var sock = _tcp;
        if (sock == null || !sock.Connected) return;
        var line = "{\"type\":\"PING\"}\n";
        try
        {
            sock.Send(Encoding.UTF8.GetBytes(line));
            Interlocked.Exchange(ref _pingSentAtTicks, DateTime.UtcNow.Ticks);
        }
        catch { }
    }

    /// <summary>Recipient-side per-peer mix gain (mirrors web setPeerGain → server PEER_GAIN).</summary>
    public void SendPeerGain(string targetUserId, float gain)
    {
        if (string.IsNullOrEmpty(RoomId)) return;
        SendJson(new Dictionary<string, object?>
        {
            ["type"] = "PEER_GAIN",
            ["room_id"] = RoomId,
            ["user_id"] = UserId,
            ["target_user_id"] = targetUserId,
            ["gain"] = gain,
        });
    }

    /// <summary>Mixer-side tuning knobs (jitter_target, jitter_max_depth, ...).</summary>
    public void SendMixerTune(IDictionary<string, object?> knobs)
    {
        if (string.IsNullOrEmpty(RoomId)) return;
        var msg = new Dictionary<string, object?>(knobs)
        {
            ["type"] = "MIXER_TUNE",
            ["room_id"] = RoomId,
            ["user_id"] = UserId,
        };
        SendJson(msg);
    }

    private void SendJson(Dictionary<string, object?> obj)
    {
        var sock = _tcp;
        if (sock == null || !sock.Connected) return;
        var json = JsonSerializer.Serialize(obj) + "\n";
        var bytes = Encoding.UTF8.GetBytes(json);
        try { sock.Send(bytes); } catch { }
    }

    // ── UDP ─────────────────────────────────────────────────────────────────

    private void OpenUdp()
    {
        var sock = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        sock.Bind(new IPEndPoint(IPAddress.Any, 0));
        _udp = sock;
        _udpRemote = new IPEndPoint(IPAddress.Parse(ServerLocation.MixerHost), _udpPort);
    }

    private void SendHandshake()
    {
        var sock = _udp;
        if (sock == null || _udpRemote == null) return;
        var pkt = SPA1.Build(Array.Empty<byte>(), SPA1.Codec.Handshake, 0, 0, UserIdKey);
        try { sock.SendTo(pkt, _udpRemote); }
        catch (Exception e) { AppLog.Log($"[Mixer] handshake err: {e.Message}"); }
    }

    public void SendAudio(byte[] pcm, ushort timestampMs)
    {
        if (State != MixerState.Connected) return;
        var sock = _udp;
        if (sock == null || _udpRemote == null) return;
        var pkt = SPA1.Build(pcm, SPA1.Codec.Pcm16, _sequence, timestampMs, UserIdKey);
        unchecked { _sequence++; }
        try { sock.SendTo(pkt, _udpRemote); }
        catch (Exception e) { AppLog.Log($"[Mixer] UDP send err: {e.Message}"); }
    }

    private void StartUdpReceive()
    {
        var t = new Thread(() =>
        {
            var sock = _udp;
            if (sock == null) return;
            var buf = new byte[2048];
            EndPoint any = new IPEndPoint(IPAddress.Any, 0);
            while (true)
            {
                int n;
                try { n = sock.ReceiveFrom(buf, ref any); }
                catch (SocketException) { break; }
                catch (ObjectDisposedException) { break; }
                if (n <= 0) continue;
                HandleUdp(buf, n);
            }
        }) { IsBackground = true, Name = "tonel.udprecv" };
        t.Start();
        _udpReadThread = t;
    }

    private void HandleUdp(byte[] buf, int n)
    {
        var span = new ReadOnlySpan<byte>(buf, 0, n);
        if (!SPA1.TryParseHeader(span, out var h)) return;
        if (h.Codec != SPA1.Codec.Pcm16) return;       // ignore handshake echo / opus
        var payload = new byte[h.DataSize];
        span.Slice(SPA1.HeaderSize, h.DataSize).CopyTo(payload);
        Packet?.Invoke(new MixerPacket(h.UserId, h.Sequence, h.Timestamp, payload));
    }
}
