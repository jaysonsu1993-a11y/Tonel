using System;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using TonelWindows.App;
using TonelWindows.Audio;

namespace TonelWindows.Network;

/// <summary>
/// WS-tunnelled twin of <see cref="MixerClient"/>. Same SPA1 wire format
/// and same MIXER_JOIN JSON control flow — what differs is the underlying
/// transport:
///
///   - control plane: <c>ws://&lt;host&gt;:9005/mixer-tcp</c> (text frames carry
///     newline-delimited JSON; identical to TCP :9002 path on the proxy's
///     other side)
///   - audio plane:   <c>ws://&lt;host&gt;:9005/mixer-udp</c> (binary frames carry
///     raw SPA1 packets; the proxy unwraps them and forwards to UDP :9003
///     on the mixer; broadcast packets come back the other way)
///
/// The proxy is `tonel-ws-mixer-proxy.js` — same node service the web
/// client uses. We just plug a native client into the same pipe.
/// Mirrors macOS WSMixerClient.swift.
/// </summary>
public sealed class WSMixerClient : IMixerTransport
{
    public ServerLocation ServerLocation { get; }

    public WSMixerClient(ServerLocation? serverLocation = null)
    {
        ServerLocation = serverLocation ?? Endpoints.DefaultServer;
    }

    public string RoomId    { get; private set; } = "";
    public string UserId    { get; private set; } = "";
    public string UserIdKey { get; private set; } = "";

    public int AudioRttMs { get; private set; } = -1;
    public int ServerJitterTargetFrames { get; private set; } = 8;
    public int ServerJitterMaxFrames    { get; private set; } = 124;

    public event Action<MixerPacket>? Packet;

    private ClientWebSocket? _control;
    private ClientWebSocket? _audio;
    private CancellationTokenSource? _cts;

    private ushort _sequence;
    private long _pingSentAtTicks;
    private Timer? _pingTimer;

    // ── Lifecycle ──────────────────────────────────────────────────────────

    public async Task ConnectAsync(string roomId, string userId)
    {
        RoomId    = roomId;
        UserId    = userId;
        UserIdKey = $"{roomId}:{userId}";

        var ctlUrl = ServerLocation.WsMixerTcpUrl
            ?? throw new InvalidOperationException($"服务器 {ServerLocation.Id} 未配置 WS 路径");
        var audUrl = ServerLocation.WsMixerUdpUrl
            ?? throw new InvalidOperationException($"服务器 {ServerLocation.Id} 未配置 WS 路径");

        AppLog.Log($"[WSMixer] connect → {ctlUrl} (control)");
        AppLog.Log($"[WSMixer]            {audUrl} (audio)");

        var deadlineCts = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        try
        {
            // 1. Control WS
            var ctl = new ClientWebSocket();
            ctl.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
            await ctl.ConnectAsync(new Uri(ctlUrl), deadlineCts.Token);
            _control = ctl;

            // 2. MIXER_JOIN + ACK
            await SendJoinAndAwaitAckAsync(deadlineCts.Token);
            AppLog.Log("[WSMixer] MIXER_JOIN_ACK received");

            // 3. Audio WS
            var aud = new ClientWebSocket();
            aud.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
            await aud.ConnectAsync(new Uri(audUrl), deadlineCts.Token);
            _audio = aud;

            // 4. SPA1 handshake (binary, codec=0xFF)
            var hs = SPA1.Build(Array.Empty<byte>(), SPA1.Codec.Handshake, 0, 0, UserIdKey);
            await aud.SendAsync(hs, WebSocketMessageType.Binary, true, deadlineCts.Token);
            AppLog.Log("[WSMixer] SPA1 handshake sent");
        }
        catch (OperationCanceledException)
        {
            await CleanupAsync();
            throw new TimeoutException($"WS 连接超时（8s）— DNS / 握手不通：{new Uri(ctlUrl).Host}");
        }
        catch
        {
            await CleanupAsync();
            throw;
        }

        // 5. Receive loops + PING (started after handshake so ping doesn't
        //    fire on a half-open connection).
        _cts = new CancellationTokenSource();
        _ = Task.Run(() => ControlReceiveLoopAsync(_control!, _cts.Token));
        _ = Task.Run(() => AudioReceiveLoopAsync(_audio!, _cts.Token));
        StartPing();
        AppLog.Log("[WSMixer] connected ✅");
    }

    public void Disconnect()
    {
        // Polite LEAVE on control plane so server frees the room slot.
        if (!string.IsNullOrEmpty(RoomId) && _control?.State == WebSocketState.Open)
        {
            var leave = $"{{\"type\":\"MIXER_LEAVE\",\"room_id\":\"{RoomId}\",\"user_id\":\"{UserId}\"}}\n";
            try
            {
                _control.SendAsync(Encoding.UTF8.GetBytes(leave),
                    WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch { }
        }
        StopPing();
        try { _cts?.Cancel(); } catch { }
        _ = CleanupAsync();
    }

    private async Task CleanupAsync()
    {
        var ctl = _control; _control = null;
        var aud = _audio;   _audio   = null;
        try { if (ctl?.State == WebSocketState.Open) await ctl.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None); } catch { }
        try { if (aud?.State == WebSocketState.Open) await aud.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None); } catch { }
        try { ctl?.Dispose(); } catch { }
        try { aud?.Dispose(); } catch { }
    }

    // ── Control plane (JSON over text frames) ──────────────────────────────

    private async Task SendJoinAndAwaitAckAsync(CancellationToken ct)
    {
        var ctl = _control ?? throw new InvalidOperationException("not connected");
        var join = $"{{\"type\":\"MIXER_JOIN\",\"room_id\":\"{RoomId}\",\"user_id\":\"{UserId}\"}}\n";
        await ctl.SendAsync(Encoding.UTF8.GetBytes(join), WebSocketMessageType.Text, true, ct);

        // Drain frames until MIXER_JOIN_ACK lands. Proxy may interleave
        // LEVELS broadcasts ahead of the ACK if other peers are mid-flight.
        var buf = new byte[16 * 1024];
        var sb = new StringBuilder();
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            var res = await ctl.ReceiveAsync(buf, ct);
            if (res.MessageType == WebSocketMessageType.Close)
                throw new InvalidOperationException("control WS closed during JOIN");
            sb.Append(Encoding.UTF8.GetString(buf, 0, res.Count));
            if (!res.EndOfMessage) continue;
            var text = sb.ToString();
            sb.Clear();
            foreach (var line in text.Split('\n'))
            {
                var t = line.Trim();
                if (!t.Contains("\"MIXER_JOIN_ACK\"")) continue;
                ParseMixerJoinAck(t);
                return;
            }
        }
        throw new TimeoutException("MIXER_JOIN 等待 ACK 超时");
    }

    private void ParseMixerJoinAck(string line)
    {
        var jt = ParseIntField(line, "jitter_target");
        if (jt > 0) ServerJitterTargetFrames = jt;
        var jm = ParseIntField(line, "jitter_max_depth");
        if (jm > 0) ServerJitterMaxFrames = jm;
    }

    private static int ParseIntField(string s, string name)
    {
        var key = $"\"{name}\":";
        var i = s.IndexOf(key, StringComparison.Ordinal);
        if (i < 0) return -1;
        i += key.Length;
        int start = i;
        while (i < s.Length && (char.IsDigit(s[i]) || (i == start && s[i] == '-'))) i++;
        return int.TryParse(s.AsSpan(start, i - start), out var v) ? v : -1;
    }

    public void SendMixerTune(IDictionary<string, object?> knobs)
    {
        var ctl = _control;
        if (string.IsNullOrEmpty(RoomId) || ctl?.State != WebSocketState.Open) return;
        var body = new Dictionary<string, object?>(knobs)
        {
            ["type"]    = "MIXER_TUNE",
            ["room_id"] = RoomId,
            ["user_id"] = UserId,
        };
        var json = JsonSerializer.Serialize(body) + "\n";
        try { _ = ctl.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, CancellationToken.None); } catch { }
    }

    public void SendPeerGain(string targetUserId, float gain)
    {
        var ctl = _control;
        if (string.IsNullOrEmpty(RoomId) || ctl?.State != WebSocketState.Open) return;
        var body = new Dictionary<string, object?>
        {
            ["type"]           = "PEER_GAIN",
            ["room_id"]        = RoomId,
            ["user_id"]        = UserId,
            ["target_user_id"] = targetUserId,
            ["gain"]           = gain,
        };
        var json = JsonSerializer.Serialize(body) + "\n";
        try { _ = ctl.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, CancellationToken.None); } catch { }
    }

    // ── Audio plane (binary SPA1 over WS frames) ──────────────────────────

    public void SendAudio(byte[] pcm, ushort timestampMs)
    {
        var aud = _audio;
        if (aud?.State != WebSocketState.Open) return;
        unchecked { _sequence++; }
        var pkt = SPA1.Build(pcm, SPA1.Codec.Pcm16, _sequence, timestampMs, UserIdKey);
        try { _ = aud.SendAsync(pkt, WebSocketMessageType.Binary, true, CancellationToken.None); }
        catch (Exception e) { AppLog.Log($"[WSMixer] audio send err: {e.Message}"); }
    }

    // ── Receive loops ──────────────────────────────────────────────────────

    private async Task ControlReceiveLoopAsync(ClientWebSocket ctl, CancellationToken ct)
    {
        var buf = new byte[16 * 1024];
        var sb = new StringBuilder();
        try
        {
            while (!ct.IsCancellationRequested && ctl.State == WebSocketState.Open)
            {
                var res = await ctl.ReceiveAsync(buf, ct);
                var recvTicks = DateTime.UtcNow.Ticks;
                if (res.MessageType == WebSocketMessageType.Close) break;
                sb.Append(Encoding.UTF8.GetString(buf, 0, res.Count));
                if (!res.EndOfMessage) continue;
                var text = sb.ToString();
                sb.Clear();

                // PONG → finalise audio RTT
                if (text.Contains("\"PONG\""))
                {
                    var sent = Interlocked.Exchange(ref _pingSentAtTicks, 0);
                    if (sent > 0)
                    {
                        var rtt = (int)((recvTicks - sent) / TimeSpan.TicksPerMillisecond);
                        if (rtt >= 0 && rtt < 10_000) AudioRttMs = rtt;
                    }
                }
                foreach (var line in text.Split('\n'))
                {
                    var t = line.Trim();
                    if (string.IsNullOrEmpty(t)) continue;
                    if (t.Contains("\"MIXER_JOIN_ACK\"") || t.Contains("\"MIXER_TUNE_ACK\""))
                        ParseMixerJoinAck(t);
                    // LEVELS / others — no-op; meters come from decoded PCM.
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception e) { AppLog.Log($"[WSMixer] control recv err: {e.Message}"); }
    }

    private async Task AudioReceiveLoopAsync(ClientWebSocket aud, CancellationToken ct)
    {
        var buf = new byte[2048];
        try
        {
            while (!ct.IsCancellationRequested && aud.State == WebSocketState.Open)
            {
                var res = await aud.ReceiveAsync(buf, ct);
                if (res.MessageType == WebSocketMessageType.Close) break;
                if (res.MessageType != WebSocketMessageType.Binary) continue;
                if (!res.EndOfMessage)
                {
                    // Frame fragmented across receives — accumulate.
                    using var ms = new System.IO.MemoryStream();
                    ms.Write(buf, 0, res.Count);
                    while (!res.EndOfMessage)
                    {
                        res = await aud.ReceiveAsync(buf, ct);
                        ms.Write(buf, 0, res.Count);
                    }
                    HandleSpa1(ms.ToArray());
                    continue;
                }
                if (res.Count > 0)
                {
                    var pkt = new byte[res.Count];
                    Buffer.BlockCopy(buf, 0, pkt, 0, res.Count);
                    HandleSpa1(pkt);
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception e) { AppLog.Log($"[WSMixer] audio recv err: {e.Message}"); }
    }

    private void HandleSpa1(byte[] data)
    {
        if (!SPA1.TryParseHeader(data, out var h)) return;
        if (h.Codec != SPA1.Codec.Pcm16) return;
        var pcm = new byte[h.DataSize];
        Buffer.BlockCopy(data, SPA1.HeaderSize, pcm, 0, h.DataSize);
        Packet?.Invoke(new MixerPacket(h.UserId, h.Sequence, h.Timestamp, pcm));
    }

    // ── PING ───────────────────────────────────────────────────────────────

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
        var ctl = _control;
        if (ctl?.State != WebSocketState.Open) return;
        Interlocked.Exchange(ref _pingSentAtTicks, DateTime.UtcNow.Ticks);
        try { _ = ctl.SendAsync(Encoding.UTF8.GetBytes("{\"type\":\"PING\"}\n"),
            WebSocketMessageType.Text, true, CancellationToken.None); } catch { }
    }
}
