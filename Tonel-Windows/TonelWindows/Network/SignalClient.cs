using System;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using TonelWindows.App;
using TonelWindows.Models;

namespace TonelWindows.Network;

public abstract record SignalMessage
{
    public sealed record PeerListMsg(IReadOnlyList<PeerInfo> Peers) : SignalMessage;
    public sealed record PeerJoinedMsg(PeerInfo Peer) : SignalMessage;
    public sealed record PeerLeftMsg(string UserId) : SignalMessage;
    public sealed record RoomListMsg(IReadOnlyList<string> Rooms) : SignalMessage;
    public sealed record JoinRoomAckMsg(string RoomId) : SignalMessage;
    public sealed record CreateRoomAckMsg(string RoomId) : SignalMessage;
    public sealed record SessionReplacedMsg(string UserId) : SignalMessage;
    public sealed record ErrorMsg(string Message) : SignalMessage;
    public sealed record HeartbeatAckMsg() : SignalMessage;

    /// <summary>v6.5.0 P2P broadcast — server tells us about a peer's NAT
    /// endpoints right after they REGISTER_AUDIO_ADDR.</summary>
    public sealed record PeerAddrMsg(
        string UserId,
        string PublicIp, ushort PublicPort,
        string LocalIp,  ushort LocalPort) : SignalMessage;

    /// <summary>v6.5.0 P2P — ack of REGISTER_AUDIO_ADDR.</summary>
    public sealed record RegisterAudioAddrAckMsg(string RoomId) : SignalMessage;
}

/// <summary>
/// WebSocket signaling client. JSON objects newline-delimited; reconnects
/// after 3s on close (web parity), unless SESSION_REPLACED latched.
/// Mirrors macOS SignalClient.swift.
/// </summary>
public sealed class SignalClient
{
    public event Action<SignalMessage>? Message;

    private ClientWebSocket? _ws;
    private CancellationTokenSource? _cts;
    private readonly object _gate = new();

    public string RoomId { get; private set; } = "";
    public string UserId { get; private set; } = "";

    private bool _sessionReplaced;
    private Timer? _heartbeatTimer;
    private Task? _reconnectTask;

    private long _pingSentAtTicks;       // wire-level ping timestamp (Stopwatch ticks via DateTime.UtcNow.Ticks)
    public int LatencyMs { get; private set; } = -1;

    public bool IsConnected => _ws?.State == WebSocketState.Open;

    public async Task ConnectAsync()
    {
        if (IsConnected) return;
        var ws = new ClientWebSocket();
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        var cts = new CancellationTokenSource();
        try
        {
            await ws.ConnectAsync(new Uri(Endpoints.SignalingUrl), cts.Token);
            AppLog.Log("[Signal] connected");
        }
        catch (Exception e)
        {
            AppLog.Log($"[Signal] connect failed: {e.Message}");
            throw;
        }
        _ws = ws;
        _cts = cts;
        StartHeartbeat();
        _ = ReceiveLoopAsync(ws, cts.Token);

        if (!string.IsNullOrEmpty(RoomId) && !string.IsNullOrEmpty(UserId))
        {
            // Replay JOIN_ROOM after reconnect.
            Send(new Dictionary<string, object?>
            {
                ["type"] = "JOIN_ROOM",
                ["room_id"] = RoomId,
                ["user_id"] = UserId,
            });
        }
    }

    public void Disconnect()
    {
        StopHeartbeat();
        var cts = _cts; _cts = null;
        try { cts?.Cancel(); } catch { }
        var ws = _ws; _ws = null;
        try
        {
            if (ws?.State == WebSocketState.Open)
                _ = ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
        }
        catch { }
    }

    public async Task JoinRoomAsync(string roomId, string userId, string? password = null)
    {
        await EnsureConnectedAsync();
        RoomId = roomId; UserId = userId;
        var msg = new Dictionary<string, object?>
        {
            ["type"] = "JOIN_ROOM",
            ["room_id"] = roomId,
            ["user_id"] = userId,
        };
        if (password != null) msg["password"] = password;
        await SendAndWaitAsync(msg, "JOIN_ROOM_ACK");
    }

    public async Task CreateRoomAsync(string roomId, string userId, string? password = null)
    {
        await EnsureConnectedAsync();
        RoomId = roomId; UserId = userId;
        var msg = new Dictionary<string, object?>
        {
            ["type"] = "CREATE_ROOM",
            ["room_id"] = roomId,
            ["user_id"] = userId,
        };
        if (password != null) msg["password"] = password;
        await SendAndWaitAsync(msg, "CREATE_ROOM_ACK");
    }

    /// <summary>v6.5.0 P2P — register our audio UDP endpoint so the server
    /// can broadcast PEER_ADDR to other room members. await ACK.</summary>
    public async Task RegisterAudioAddrAsync(string roomId, string userId,
        string publicIp, ushort publicPort, string localIp, ushort localPort)
    {
        await EnsureConnectedAsync();
        var msg = new Dictionary<string, object?>
        {
            ["type"]        = "REGISTER_AUDIO_ADDR",
            ["room_id"]     = roomId,
            ["user_id"]     = userId,
            ["public_ip"]   = publicIp,
            ["public_port"] = (int)publicPort,
            ["local_ip"]    = localIp,
            ["local_port"]  = (int)localPort,
        };
        await SendAndWaitAsync(msg, "REGISTER_AUDIO_ADDR_ACK");
    }

    public void LeaveRoom()
    {
        if (string.IsNullOrEmpty(RoomId)) return;
        Send(new Dictionary<string, object?>
        {
            ["type"] = "LEAVE_ROOM",
            ["room_id"] = RoomId,
            ["user_id"] = UserId,
        });
        RoomId = ""; UserId = "";
    }

    private async Task EnsureConnectedAsync()
    {
        if (!IsConnected) await ConnectAsync();
    }

    private void Send(Dictionary<string, object?> obj)
    {
        var ws = _ws;
        if (ws?.State != WebSocketState.Open) return;
        var json = JsonSerializer.Serialize(obj) + "\n";
        var bytes = Encoding.UTF8.GetBytes(json);
        try { _ = ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None); }
        catch (Exception e) { AppLog.Log($"[Signal] send err: {e.Message}"); }
    }

    private async Task SendAndWaitAsync(Dictionary<string, object?> obj, string ackType,
                                        int timeoutMs = 8000)
    {
        var tcs = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
        Action<SignalMessage>? handler = null;
        handler = msg =>
        {
            switch (msg)
            {
                case SignalMessage.JoinRoomAckMsg j when ackType == "JOIN_ROOM_ACK" && j.RoomId == RoomId:
                case SignalMessage.CreateRoomAckMsg c when ackType == "CREATE_ROOM_ACK" && c.RoomId == RoomId:
                case SignalMessage.RegisterAudioAddrAckMsg ra when ackType == "REGISTER_AUDIO_ADDR_ACK" && ra.RoomId == RoomId:
                    Message -= handler!;
                    tcs.TrySetResult(null);
                    break;
                case SignalMessage.ErrorMsg em:
                    Message -= handler!;
                    tcs.TrySetException(new Exception(em.Message));
                    break;
            }
        };
        Message += handler;
        Send(obj);

        using var cts = new CancellationTokenSource(timeoutMs);
        cts.Token.Register(() =>
        {
            Message -= handler;
            tcs.TrySetException(new TimeoutException("连接超时"));
        });
        await tcs.Task.ConfigureAwait(false);
    }

    private async Task ReceiveLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buf = new byte[16 * 1024];
        var sb = new StringBuilder();
        try
        {
            while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
            {
                var res = await ws.ReceiveAsync(buf, ct);
                // Stamp recv as close to wire as possible.
                var recvTicks = DateTime.UtcNow.Ticks;
                if (res.MessageType == WebSocketMessageType.Close) break;
                sb.Append(Encoding.UTF8.GetString(buf, 0, res.Count));
                if (!res.EndOfMessage) continue;

                var text = sb.ToString();
                sb.Clear();

                // Quick pre-check for PONG/HEARTBEAT_ACK so latency is computed
                // without waiting on the dispatch hop.
                if (text.Contains("HEARTBEAT_ACK") || text.Contains("\"PONG\""))
                {
                    var sent = Interlocked.Exchange(ref _pingSentAtTicks, 0);
                    if (sent > 0)
                        LatencyMs = (int)((recvTicks - sent) / TimeSpan.TicksPerMillisecond);
                }
                foreach (var line in text.Split('\n'))
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    DispatchLine(line);
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception e) { AppLog.Log($"[Signal] recv err: {e.Message}"); }
        HandleClose();
    }

    private void DispatchLine(string line)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(line); }
        catch { return; }
        if (!doc.RootElement.TryGetProperty("type", out var typeEl)) return;
        var type = typeEl.GetString() ?? "";

        if (type == "PONG" || type == "HEARTBEAT_ACK")
        {
            Emit(new SignalMessage.HeartbeatAckMsg());
            return;
        }
        if (type == "SESSION_REPLACED")
        {
            _sessionReplaced = true;
            Emit(new SignalMessage.SessionReplacedMsg(GetStr(doc.RootElement, "user_id")));
            return;
        }
        switch (type)
        {
            case "PEER_LIST":
                {
                    var list = new List<PeerInfo>();
                    if (doc.RootElement.TryGetProperty("peers", out var peers) &&
                        peers.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var p in peers.EnumerateArray())
                        {
                            var uid = GetStr(p, "user_id");
                            if (!string.IsNullOrEmpty(uid)) list.Add(new PeerInfo(uid));
                        }
                    }
                    Emit(new SignalMessage.PeerListMsg(list));
                    break;
                }
            case "PEER_JOINED":
                Emit(new SignalMessage.PeerJoinedMsg(new PeerInfo(GetStr(doc.RootElement, "user_id"))));
                break;
            case "PEER_LEFT":
                Emit(new SignalMessage.PeerLeftMsg(GetStr(doc.RootElement, "user_id")));
                break;
            case "ROOM_LIST":
                {
                    var list = new List<string>();
                    if (doc.RootElement.TryGetProperty("rooms", out var rooms) &&
                        rooms.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var r in rooms.EnumerateArray())
                            if (r.ValueKind == JsonValueKind.String) list.Add(r.GetString()!);
                    }
                    Emit(new SignalMessage.RoomListMsg(list));
                    break;
                }
            case "JOIN_ROOM_ACK":
                Emit(new SignalMessage.JoinRoomAckMsg(GetStr(doc.RootElement, "room_id")));
                break;
            case "CREATE_ROOM_ACK":
                Emit(new SignalMessage.CreateRoomAckMsg(GetStr(doc.RootElement, "room_id")));
                break;
            case "ERROR":
                Emit(new SignalMessage.ErrorMsg(GetStr(doc.RootElement, "message", "unknown")));
                break;
            case "PEER_ADDR":
                {
                    var uid     = GetStr(doc.RootElement, "user_id");
                    var pubIp   = GetStr(doc.RootElement, "public_ip");
                    var pubPort = (ushort)(GetInt(doc.RootElement, "public_port") & 0xFFFF);
                    var locIp   = GetStr(doc.RootElement, "local_ip");
                    var locPort = (ushort)(GetInt(doc.RootElement, "local_port") & 0xFFFF);
                    if (!string.IsNullOrEmpty(uid))
                        Emit(new SignalMessage.PeerAddrMsg(uid, pubIp, pubPort, locIp, locPort));
                    break;
                }
            case "REGISTER_AUDIO_ADDR_ACK":
                Emit(new SignalMessage.RegisterAudioAddrAckMsg(GetStr(doc.RootElement, "room_id")));
                break;
        }
    }

    private static string GetStr(JsonElement el, string name, string fallback = "")
        => el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() ?? fallback : fallback;

    private static int GetInt(JsonElement el, string name, int fallback = 0)
        => el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i)
            ? i : fallback;

    private void Emit(SignalMessage msg) => Message?.Invoke(msg);

    private void HandleClose()
    {
        StopHeartbeat();
        _ws = null;
        if (!_sessionReplaced) ScheduleReconnect();
    }

    private void ScheduleReconnect()
    {
        lock (_gate)
        {
            if (_reconnectTask != null) return;
            _reconnectTask = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(3000);
                    lock (_gate) { _reconnectTask = null; }
                    try { await ConnectAsync(); } catch { }
                }
                catch { }
            });
        }
    }

    private void StartHeartbeat()
    {
        StopHeartbeat();
        _heartbeatTimer = new Timer(_ => SendHeartbeat(), null, 5000, 5000);
    }

    private void StopHeartbeat()
    {
        var t = _heartbeatTimer; _heartbeatTimer = null;
        t?.Dispose();
        Interlocked.Exchange(ref _pingSentAtTicks, 0);
    }

    private void SendHeartbeat()
    {
        var ws = _ws;
        if (ws?.State != WebSocketState.Open) return;
        var payload = $"{{\"type\":\"HEARTBEAT\",\"user_id\":\"{UserId}\"}}\n";
        var bytes = Encoding.UTF8.GetBytes(payload);
        try
        {
            // Stamp ticks AFTER kernel has accepted. SendAsync returning =
            // closest we get to "bytes on wire" without hooking IOCP.
            ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None)
              .ContinueWith(t =>
              {
                  if (!t.IsFaulted)
                      Interlocked.Exchange(ref _pingSentAtTicks, DateTime.UtcNow.Ticks);
              });
        }
        catch { }
    }
}
