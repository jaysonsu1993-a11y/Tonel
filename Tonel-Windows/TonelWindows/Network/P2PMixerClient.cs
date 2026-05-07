using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using TonelWindows.App;
using TonelWindows.Audio;

namespace TonelWindows.Network;

/// <summary>
/// v6.5.0 peer-to-peer transport. Each client opens a single UDP socket,
/// learns its NAT-mapped public address from the signaling server,
/// registers that address into the room, then sends SPA1 audio frames
/// directly to every other peer in the room (and receives theirs the
/// same way). Server is signaling-only; audio path never touches the
/// central mixer.
///
/// Topology: full mesh (N peers → N-1 outbound streams). Mixing is local —
/// AudioEngine's per-peer JitterBuffer handles the inbound side unchanged.
///
/// NAT traversal: hole-punching, no TURN fallback. On receiving a peer's
/// address pair we spray <see cref="SPA1.Codec.PeerHello"/> packets at
/// ~100 ms intervals to BOTH the peer's public and local addresses; the
/// first inbound packet from that peer "wins" and its source becomes the
/// steady-state route. Cone-NAT works; symmetric NAT will fail (peer
/// just stays unreachable in the UI).
///
/// Mirrors macOS P2PMixerClient.swift.
/// </summary>
public sealed class P2PMixerClient : IMixerTransport
{
    public ServerLocation ServerLocation { get; }
    /// <summary>SignalClient owned by AppState — used for REGISTER_AUDIO_ADDR
    /// + PEER_ADDR / PEER_LEFT subscription. We don't open our own.</summary>
    private readonly SignalClient _signal;

    public P2PMixerClient(SignalClient signal, ServerLocation? serverLocation = null)
    {
        ServerLocation = serverLocation ?? Endpoints.DefaultServer;
        _signal = signal;
    }

    public string RoomId    { get; private set; } = "";
    public string UserId    { get; private set; } = "";
    public string UserIdKey { get; private set; } = "";

    /// <summary>P2P has no central PING — RTT comes from PeerPing timestamp
    /// echo. -1 until first peer is reachable.</summary>
    public int AudioRttMs { get; private set; } = -1;
    /// <summary>MIXER_JOIN_ACK doesn't apply in P2P. Synthetic defaults so
    /// the e2e display + debug sliders open at sensible numbers.</summary>
    public int ServerJitterTargetFrames { get; private set; } = 8;
    public int ServerJitterMaxFrames    { get; private set; } = 124;

    public event Action<MixerPacket>? Packet;

    private Socket? _sock;
    private ushort _localPort;
    private Thread? _recvThread;
    private CancellationTokenSource? _cts;

    private sealed class Peer
    {
        public string UserId = "";
        public IPEndPoint PublicAddr = new(IPAddress.Any, 0);
        public IPEndPoint LocalAddr  = new(IPAddress.Any, 0);
        /// <summary>Whichever of Public/Local first echoed back a hole-punch
        /// hello. Until set, hellos are sprayed at both.</summary>
        public IPEndPoint? Working;
        public long LastInboundTicks;
    }
    private readonly Dictionary<string, Peer> _peers = new();
    private readonly object _peersGate = new();

    private Action? _unsubSignal;
    private Timer? _holePunchTimer;
    private Timer? _keepaliveTimer;

    private ushort _sequence;

    // ── Lifecycle ──────────────────────────────────────────────────────────

    public async Task ConnectAsync(string roomId, string userId)
    {
        RoomId    = roomId;
        UserId    = userId;
        UserIdKey = $"{roomId}:{userId}";

        AppLog.Log($"[P2P] connect → server={ServerLocation.Id} discovery={ServerLocation.MixerHost}:{ServerLocation.P2PDiscoveryUdpPort} room={roomId}");

        // 1. Open local UDP socket on a random port.
        OpenSocket();
        AppLog.Log($"[P2P] local UDP bound on port {_localPort}");

        // 2. Subscribe to PEER_ADDR / PEER_LEFT BEFORE registering, so we
        //    don't race-miss any peer addrs the server emits in response.
        Action<SignalMessage> handler = HandleSignalMessage;
        _signal.Message += handler;
        _unsubSignal = () => _signal.Message -= handler;

        // 3. UDP NAT discovery — bounded by 5s.
        var publicEp = await DiscoverPublicAddressAsync();
        AppLog.Log($"[P2P] public addr = {publicEp}");

        // 4. Tell server about our endpoints.
        var localEp = CurrentLocalAddress();
        await _signal.RegisterAudioAddrAsync(roomId, userId,
            publicEp.Address.ToString(), (ushort)publicEp.Port,
            localEp.Address.ToString(),  (ushort)localEp.Port);
        AppLog.Log("[P2P] REGISTER_AUDIO_ADDR_ACK received");

        // 5. Receive loop + hole-punch + keepalive.
        _cts = new CancellationTokenSource();
        StartReceiveThread();
        StartHolePunchTimer();
        StartKeepaliveTimer();

        AppLog.Log("[P2P] connected ✅");
    }

    public void Disconnect()
    {
        _holePunchTimer?.Dispose(); _holePunchTimer = null;
        _keepaliveTimer?.Dispose(); _keepaliveTimer = null;
        try { _unsubSignal?.Invoke(); } catch { }
        _unsubSignal = null;
        try { _cts?.Cancel(); } catch { }
        try { _sock?.Close(); } catch { }
        _sock = null;
        try { _recvThread?.Join(500); } catch { }
        _recvThread = null;
        lock (_peersGate) _peers.Clear();
        RoomId = ""; UserId = ""; UserIdKey = "";
        AppLog.Log("[P2P] disconnected");
    }

    // ── Audio plane ────────────────────────────────────────────────────────

    public void SendAudio(byte[] pcm, ushort timestampMs)
    {
        var sock = _sock;
        if (sock == null) return;
        unchecked { _sequence++; }
        var pkt = SPA1.Build(pcm, SPA1.Codec.Pcm16, _sequence, timestampMs, UserIdKey);

        // Snapshot under lock; send outside.
        Peer[] snapshot;
        lock (_peersGate) snapshot = _peers.Values.ToArray();

        foreach (var peer in snapshot)
        {
            if (peer.Working is { } working)
            {
                TrySend(sock, pkt, working);
            }
            else
            {
                // Pre-hole-punch: spray at both. The outbound packet itself
                // primes the NAT mapping, doubling as a hello.
                TrySend(sock, pkt, peer.PublicAddr);
                TrySend(sock, pkt, peer.LocalAddr);
            }
        }
    }

    // ── Control plane (no-op for P2P) ──────────────────────────────────────

    public void SendMixerTune(IDictionary<string, object?> knobs) { /* intentional no-op */ }
    public void SendPeerGain(string targetUserId, float gain)     { /* intentional no-op */ }

    // ── Internals ──────────────────────────────────────────────────────────

    private void OpenSocket()
    {
        var sock = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        sock.Bind(new IPEndPoint(IPAddress.Any, 0));
        var local = (IPEndPoint)sock.LocalEndPoint!;
        _localPort = (ushort)local.Port;
        // Increase receive buffer so a brief stall in the recv thread doesn't
        // drop audio bursts. 256k = ~1.7s worth of one peer at v6.0.0 rate.
        try { sock.ReceiveBufferSize = 256 * 1024; } catch { }
        _sock = sock;
    }

    private async Task<IPEndPoint> DiscoverPublicAddressAsync()
    {
        var sock = _sock ?? throw new InvalidOperationException("not bound");
        var dst = new IPEndPoint(IPAddress.Parse(ServerLocation.MixerHost),
                                  ServerLocation.P2PDiscoveryUdpPort);
        var payload = $"{{\"type\":\"DISCOVER\",\"user_id\":\"{UserId}\"}}";
        var bytes = Encoding.UTF8.GetBytes(payload);

        var deadline = DateTime.UtcNow.AddSeconds(5);
        var buf = new byte[1500];

        while (DateTime.UtcNow < deadline)
        {
            try { sock.SendTo(bytes, dst); } catch { }

            // Wait up to 200ms for a reply.
            if (sock.Poll(200_000, SelectMode.SelectRead))
            {
                EndPoint src = new IPEndPoint(IPAddress.Any, 0);
                int n;
                try { n = sock.ReceiveFrom(buf, ref src); }
                catch (SocketException) { continue; }
                if (n <= 0) continue;
                var s = Encoding.UTF8.GetString(buf, 0, n);
                var ep = ParseDiscoverReply(s);
                if (ep != null) return ep;
                // Otherwise probably a stray packet (handshake echo from
                // another path); keep waiting.
            }
            await Task.Yield();
        }
        throw new TimeoutException("P2P NAT 发现超时（5s）");
    }

    private static IPEndPoint? ParseDiscoverReply(string s)
    {
        if (!s.Contains("\"DISCOVER_REPLY\"")) return null;
        try
        {
            var doc = JsonDocument.Parse(s);
            var ip   = doc.RootElement.TryGetProperty("public_ip",   out var ipEl)   ? ipEl.GetString() ?? "" : "";
            var port = doc.RootElement.TryGetProperty("public_port", out var portEl) && portEl.TryGetInt32(out var p) ? p : 0;
            if (string.IsNullOrEmpty(ip) || port <= 0 || port > 65535) return null;
            return new IPEndPoint(IPAddress.Parse(ip), port);
        }
        catch { return null; }
    }

    private IPEndPoint CurrentLocalAddress()
    {
        // First non-loopback, non-tunnel IPv4 from the active interfaces.
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up) continue;
            if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            if (nic.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;
            var props = nic.GetIPProperties();
            foreach (var ua in props.UnicastAddresses)
            {
                if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                if (IPAddress.IsLoopback(ua.Address)) continue;
                return new IPEndPoint(ua.Address, _localPort);
            }
        }
        return new IPEndPoint(IPAddress.Any, _localPort);
    }

    // ── Receive loop ───────────────────────────────────────────────────────

    private void StartReceiveThread()
    {
        var t = new Thread(RunReceiveLoop)
        {
            IsBackground = true,
            Name = "tonel.p2p.recv",
            Priority = ThreadPriority.Highest,
        };
        _recvThread = t;
        t.Start();
    }

    private void RunReceiveLoop()
    {
        var sock = _sock;
        if (sock == null) return;
        var buf = new byte[1500];
        EndPoint src = new IPEndPoint(IPAddress.Any, 0);
        while (_cts is { IsCancellationRequested: false } && _sock != null)
        {
            int n;
            try { n = sock.ReceiveFrom(buf, ref src); }
            catch (SocketException) { break; }
            catch (ObjectDisposedException) { break; }
            if (n <= 0) continue;
            var data = new byte[n];
            Buffer.BlockCopy(buf, 0, data, 0, n);
            HandleInbound(data, (IPEndPoint)src);
        }
    }

    private void HandleInbound(byte[] data, IPEndPoint src)
    {
        if (!SPA1.TryParseHeader(data, out var h)) return;

        // Strip "roomId:" prefix from the SPA1 sender id.
        var senderUid = h.UserId;
        var colon = senderUid.IndexOf(':');
        var bareUid = colon >= 0 ? senderUid.Substring(colon + 1) : senderUid;
        if (string.IsNullOrEmpty(bareUid) || bareUid == UserId) return;     // ignore loopback

        // Lock in source addr as the working route.
        lock (_peersGate)
        {
            if (_peers.TryGetValue(bareUid, out var peer))
            {
                if (peer.Working == null)
                {
                    peer.Working = src;
                    AppLog.Log($"[P2P] peer {bareUid} addr resolved via incoming = {src}");
                }
                peer.LastInboundTicks = DateTime.UtcNow.Ticks;
            }
        }

        switch (h.Codec)
        {
            case SPA1.Codec.Pcm16:
            {
                var pcm = new byte[h.DataSize];
                Buffer.BlockCopy(data, SPA1.HeaderSize, pcm, 0, h.DataSize);
                Packet?.Invoke(new MixerPacket(senderUid, h.Sequence, h.Timestamp, pcm));
                break;
            }
            case SPA1.Codec.PeerHello:
                // First-contact / hole-punch reply. Address-locking already
                // done above; nothing else to do.
                break;
            case SPA1.Codec.PeerPing:
            {
                // Timestamp echo for RTT, same scale as mixer broadcasts.
                ushort nowLow16 = unchecked((ushort)((long)(DateTime.UtcNow - DateTime.UnixEpoch).TotalMilliseconds / 100 & 0xFFFF));
                int delta = unchecked((ushort)(nowLow16 - h.Timestamp));
                int rtt = delta * 100;
                if (rtt >= 0 && rtt < 10_000) AudioRttMs = rtt;
                break;
            }
        }
    }

    // ── Hole-punch + keepalive ─────────────────────────────────────────────

    private void StartHolePunchTimer()
    {
        // Spray PeerHello at every peer that doesn't yet have a working
        // route. 100ms interval. Once `Working` is non-null, audio sends
        // alone keep the NAT mapping warm.
        _holePunchTimer = new Timer(_ => TickHolePunch(), null, 0, 100);
    }

    private void TickHolePunch()
    {
        var sock = _sock;
        if (sock == null) return;
        var hello = SPA1.Build(Array.Empty<byte>(), SPA1.Codec.PeerHello, 0, 0, UserIdKey);
        Peer[] pending;
        lock (_peersGate)
            pending = _peers.Values.Where(p => p.Working == null).ToArray();
        foreach (var peer in pending)
        {
            TrySend(sock, hello, peer.PublicAddr);
            TrySend(sock, hello, peer.LocalAddr);
        }
    }

    private void StartKeepaliveTimer()
    {
        _keepaliveTimer = new Timer(_ => TickKeepalive(), null, 5000, 5000);
    }

    private void TickKeepalive()
    {
        var sock = _sock;
        if (sock == null) return;
        ushort ts = unchecked((ushort)((long)(DateTime.UtcNow - DateTime.UnixEpoch).TotalMilliseconds / 100 & 0xFFFF));
        var ping = SPA1.Build(Array.Empty<byte>(), SPA1.Codec.PeerPing, 0, ts, UserIdKey);
        Peer[] snapshot;
        lock (_peersGate) snapshot = _peers.Values.ToArray();
        foreach (var peer in snapshot)
        {
            if (peer.Working is { } w) TrySend(sock, ping, w);
        }
    }

    private static void TrySend(Socket sock, byte[] data, IPEndPoint dst)
    {
        try { sock.SendTo(data, dst); } catch { /* one-shot UDP; ignore */ }
    }

    // ── Signal-layer handlers ──────────────────────────────────────────────

    private void HandleSignalMessage(SignalMessage msg)
    {
        switch (msg)
        {
            case SignalMessage.PeerAddrMsg pa:
                if (string.IsNullOrEmpty(pa.UserId) || pa.UserId == UserId) return;
                IPAddress pubIp = IPAddress.TryParse(pa.PublicIp, out var pip) ? pip : IPAddress.Any;
                IPAddress locIp = IPAddress.TryParse(string.IsNullOrEmpty(pa.LocalIp) ? "0.0.0.0" : pa.LocalIp, out var lip) ? lip : IPAddress.Any;
                lock (_peersGate)
                {
                    if (!_peers.TryGetValue(pa.UserId, out var existing))
                    {
                        _peers[pa.UserId] = new Peer
                        {
                            UserId = pa.UserId,
                            PublicAddr = new IPEndPoint(pubIp, pa.PublicPort),
                            LocalAddr  = new IPEndPoint(locIp, pa.LocalPort),
                        };
                        AppLog.Log($"[P2P] peer added {pa.UserId} public={pa.PublicIp}:{pa.PublicPort} local={pa.LocalIp}:{pa.LocalPort}");
                    }
                    else
                    {
                        // Re-register after reconnect. Refresh addrs but
                        // keep the existing working route until a hole-punch
                        // on the new addr succeeds. Conservative.
                        existing.PublicAddr = new IPEndPoint(pubIp, pa.PublicPort);
                        existing.LocalAddr  = new IPEndPoint(locIp, pa.LocalPort);
                    }
                }
                break;
            case SignalMessage.PeerLeftMsg pl:
                lock (_peersGate) _peers.Remove(pl.UserId);
                AppLog.Log($"[P2P] peer removed {pl.UserId}");
                break;
        }
    }
}
