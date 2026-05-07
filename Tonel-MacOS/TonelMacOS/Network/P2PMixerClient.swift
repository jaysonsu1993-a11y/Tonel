import Foundation
import Network
import Darwin

/// v6.5.0 — peer-to-peer transport. Each client opens a single UDP
/// socket, learns its NAT-mapped public address from the signaling
/// server, registers that address into the room, then sends SPA1
/// audio frames directly to every other peer in the room (and
/// receives theirs the same way). The signaling server is involved
/// only for room membership + peer-address exchange; the audio
/// path never touches the central mixer.
///
/// **Topology**: full mesh. With N peers each client maintains N-1
/// outbound streams. Mixing is local — `AudioEngine`'s per-peer
/// `JitterBuffer` infrastructure (originally built for the mixer
/// path's broadcast packets) handles the inbound side without
/// modification.
///
/// **NAT traversal**: hole-punching, no TURN fallback. On receiving
/// a peer's address pair, immediately send `SPA1.peerHello` packets
/// at ~100 ms intervals to BOTH the peer's public and local
/// addresses. The first inbound packet from that peer "wins" — its
/// source address (local OR public) becomes the steady-state route.
/// This works for the common consumer-router cone NAT case; symmetric
/// NAT will simply fail to connect (peer never reachable, surfaced as
/// a missing peer in the UI). See `project_v6_p2p` memory for the
/// design rationale and SonoBus-derived state machine.
///
/// **Why a separate class instead of bolting onto MixerClient**: the
/// audio path is fundamentally different (1-N fan-out instead of 1-1
/// to the server), the control plane uses signaling messages instead
/// of the mixer's TCP, and there's no MIXER_TUNE / MIXER_JOIN dance.
/// The two implementations share roughly nothing beyond the SPA1
/// wire format.
final class P2PMixerClient: MixerTransport {
    typealias PacketHandler = (MixerPacket) -> Void

    // MARK: - Identity / endpoints

    let serverLocation: ServerLocation
    /// SignalClient instance owned by AppState — used for the
    /// REGISTER_AUDIO_ADDR call + peerAddr/peerLeft subscription.
    /// We don't open our own signaling channel.
    private weak var signal: SignalClient?

    init(serverLocation: ServerLocation = Endpoints.defaultServer,
         signal: SignalClient) {
        self.serverLocation = serverLocation
        self.signal = signal
    }

    private(set) var roomId    = ""
    private(set) var userId    = ""
    private(set) var userIdKey = ""

    // MARK: - State observed by SwiftUI

    /// P2P has no central PING/PONG channel — RTT is the rolling EMA
    /// of the SPA1 timestamp echo across active peers (or `-1` while
    /// no peers are reachable). Maintained in `handlePeerPing`.
    nonisolated(unsafe) private(set) var audioRttMs: Int = -1
    /// MIXER_JOIN_ACK doesn't apply in P2P. Expose synthetic values
    /// matching the mixer's v6.0.0 defaults so the e2e latency
    /// display + AudioDebugSheet sliders open at sensible numbers.
    private(set) var serverJitterTargetFrames: Int = 8
    private(set) var serverJitterMaxFrames:    Int = 124

    // MARK: - Audio socket

    private var udp: NWConnection?              // unused on P2P; retained for protocol parity
    /// POSIX UDP socket bound to a random port. POSIX (not
    /// NWConnection) for the same reason MixerClient uses POSIX TCP:
    /// system proxy bypass, predictable behaviour, and we need the
    /// raw socket fd for `recvfrom`-style packet-source-aware
    /// receive (every inbound packet's source addr matters for
    /// hole-punch resolution).
    private var sock: Int32 = -1
    private var localPort: UInt16 = 0
    private var recvThread: Thread?
    private let sendQueue = DispatchQueue(label: "io.tonel.p2p.send", qos: .userInitiated)

    // MARK: - Per-peer state

    /// Address-pair as advertised by the server, plus the resolved
    /// "working" address once a hole-punch reply lands. Lives in
    /// `peers[uid]`; the receive loop mutates `working` from the
    /// recv thread under `peersLock`.
    private struct Peer {
        let userId: String
        var publicAddr: sockaddr_in
        var localAddr:  sockaddr_in
        /// Whichever of `publicAddr` / `localAddr` first echoed back
        /// our hole-punch hello. Until set, we spray hellos at both.
        var working: sockaddr_in?
        var lastInboundTs: TimeInterval = 0
    }
    private var peers: [String: Peer] = [:]
    private let peersLock = NSLock()

    // MARK: - Subscriptions / timers

    private var unsubSignal: (() -> Void)?
    private var holePunchTimer: Timer?
    private var keepaliveTimer: Timer?

    // MARK: - Packet handlers

    private var packetHandlers: [(UUID, PacketHandler)] = []
    func onPacket(_ h: @escaping PacketHandler) -> () -> Void {
        let id = UUID()
        packetHandlers.append((id, h))
        return { [weak self] in
            self?.packetHandlers.removeAll { $0.0 == id }
        }
    }

    // MARK: - Sequence

    private var sequence: UInt16 = 0

    // MARK: - Connect / disconnect

    func connect(roomId: String, userId: String) async throws {
        self.roomId    = roomId
        self.userId    = userId
        self.userIdKey = "\(roomId):\(userId)"

        AppLog.log("[P2P] connect → server=\(serverLocation.id) discovery=\(serverLocation.mixerHost):\(serverLocation.p2pDiscoveryUDPPort) room=\(roomId)")

        // 1. Open local UDP socket on a random port.
        try openUDPSocket()
        AppLog.log("[P2P] local UDP bound on port \(localPort)")

        // 2. Subscribe to PEER_ADDR / PEER_LEFT on the SignalClient
        // BEFORE we register, so we don't race-miss any peer addrs the
        // server emits on receiving our REGISTER. (The server replies
        // to the registrar with the existing-peer addrs in a tight
        // loop right before sending REGISTER_AUDIO_ADDR_ACK.)
        guard let signal = signal else {
            throw P2PError.noSignal
        }
        // SignalClient is @MainActor — hop there to register the
        // observer. The closure itself fires on main, which is fine
        // for the lightweight bookkeeping `handleSignalMessage` does
        // (mutating the `peers` dict under a lock, no audio work).
        unsubSignal = await MainActor.run {
            signal.onMessage { [weak self] msg in
                self?.handleSignalMessage(msg)
            }
        }

        // 3. UDP NAT discovery: send DISCOVER, receive DISCOVER_REPLY
        // synchronously on the local UDP socket. Bounded by 5 s.
        let publicAddr = try await discoverPublicAddress()
        AppLog.log("[P2P] public addr = \(publicAddr.ip):\(publicAddr.port)")

        // 4. Tell the server about our endpoints.
        let localAddr = currentLocalAddress()
        try await signal.registerAudioAddr(roomId: roomId, userId: userId,
                                           publicIP: publicAddr.ip, publicPort: publicAddr.port,
                                           localIP:  localAddr.ip,  localPort:  localAddr.port)
        AppLog.log("[P2P] REGISTER_AUDIO_ADDR_ACK received")

        // 5. Start the receive loop + hole-punch + keepalive timers.
        startReceiveLoop()
        startHolePunchTimer()
        startKeepaliveTimer()

        AppLog.log("[P2P] connected ✅")
    }

    func disconnect() {
        holePunchTimer?.invalidate(); holePunchTimer = nil
        keepaliveTimer?.invalidate(); keepaliveTimer = nil
        unsubSignal?(); unsubSignal = nil
        recvThread?.cancel(); recvThread = nil
        if sock >= 0 {
            Darwin.shutdown(sock, SHUT_RDWR)
            Darwin.close(sock)
            sock = -1
        }
        peersLock.lock()
        peers.removeAll()
        peersLock.unlock()
        roomId = ""; userId = ""; userIdKey = ""
        AppLog.log("[P2P] disconnected")
    }

    // MARK: - Audio plane

    /// Send one PCM16 frame to every peer that has at least one
    /// candidate address. Pre-hole-punch peers get the packet sent at
    /// both `localAddr` and `publicAddr` (which doubles as the
    /// hole-punch payload — the OUTBOUND packet primes the NAT
    /// mapping just like a synthetic hello would). Post-hole-punch
    /// peers get a single send to their working addr.
    func sendAudio(pcm: Data, timestampMs: UInt16) {
        guard sock >= 0 else { return }
        sequence &+= 1
        let pkt = SPA1.build(payload: pcm,
                             codec: .pcm16,
                             sequence: sequence,
                             timestamp: timestampMs,
                             userId: userIdKey)

        // Snapshot peers under lock, send outside lock.
        peersLock.lock()
        let snapshot = Array(peers.values)
        peersLock.unlock()

        for peer in snapshot {
            if var w = peer.working {
                sendQueue.async { [weak self] in
                    self?.sendDatagram(pkt, to: &w)
                }
            } else {
                var pub = peer.publicAddr
                var loc = peer.localAddr
                sendQueue.async { [weak self] in
                    self?.sendDatagram(pkt, to: &pub)
                    self?.sendDatagram(pkt, to: &loc)
                }
            }
        }
    }

    // MARK: - Control plane (no-op for P2P)

    /// MIXER_TUNE doesn't apply in P2P. Knobs surfaced in the
    /// AudioDebugSheet only affect this client's local jitter buffer
    /// (which is the only buffer in the audio path now). Drop the
    /// outbound knobs but keep the local-only effect by pushing the
    /// values into the static var on JitterBuffer via AudioEngine —
    /// that's already wired by the @Published properties.
    func sendMixerTune(_ knobs: [String: Any]) {
        // intentional no-op
    }

    /// PEER_GAIN doesn't apply either — there's no central mixer to
    /// apply per-recipient gain on. AudioEngine's local
    /// `setPeerGain` already tunes the per-peer mix-in level
    /// post-decode, which is the only place gain matters in P2P.
    func sendPeerGain(targetUserId: String, gain: Float) {
        // intentional no-op
    }

    // MARK: - Internals

    private enum P2PError: LocalizedError {
        case socketOpen(String)
        case socketBind(String)
        case discoveryTimeout
        case noSignal
        var errorDescription: String? {
            switch self {
            case .socketOpen(let m):   return "P2P UDP open: \(m)"
            case .socketBind(let m):   return "P2P UDP bind: \(m)"
            case .discoveryTimeout:    return "P2P NAT 发现超时（5s）"
            case .noSignal:            return "P2P 需要信令通道，但未连接"
            }
        }
    }

    private struct Endpoint { let ip: String; let port: UInt16 }

    private func openUDPSocket() throws {
        let s = Darwin.socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard s >= 0 else {
            throw P2PError.socketOpen(String(cString: strerror(errno)))
        }
        // Bind to ephemeral port (kernel picks).
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = INADDR_ANY
        let bindOK = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(s, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindOK == 0 else {
            let m = String(cString: strerror(errno))
            Darwin.close(s)
            throw P2PError.socketBind(m)
        }
        // Read back the kernel-assigned port for our REGISTER payload.
        var bound = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        withUnsafeMutablePointer(to: &bound) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                _ = Darwin.getsockname(s, sa, &len)
            }
        }
        sock = s
        localPort = UInt16(bigEndian: bound.sin_port)
    }

    /// Send a UDP `DISCOVER` packet to the server's discovery port,
    /// wait up to 5s for `DISCOVER_REPLY` on the same socket, parse
    /// the public address out of it. The send/recv share `sock`
    /// because the kernel-mapped public port we want to learn is the
    /// one for THIS specific socket.
    private func discoverPublicAddress() async throws -> Endpoint {
        guard sock >= 0 else { throw P2PError.socketOpen("not bound") }

        // Build target sockaddr.
        var dst = sockaddr_in()
        dst.sin_family = sa_family_t(AF_INET)
        dst.sin_port = serverLocation.p2pDiscoveryUDPPort.bigEndian
        dst.sin_addr.s_addr = inet_addr(serverLocation.mixerHost)

        let payload = "{\"type\":\"DISCOVER\",\"user_id\":\"\(userId)\"}"

        // Send a few DISCOVER probes (UDP loss, server may be busy).
        // 100ms apart × 3 attempts.
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Endpoint, Error>) in
            let q = DispatchQueue(label: "io.tonel.p2p.discover")
            q.async { [weak self] in
                guard let self = self else {
                    cont.resume(throwing: P2PError.socketOpen("released"))
                    return
                }
                // Try up to 5s, sending every 200 ms.
                let deadline = Date().addingTimeInterval(5.0)
                var lastErr = ""
                while Date() < deadline {
                    // Send one probe.
                    payload.withCString { cstr in
                        _ = withUnsafePointer(to: &dst) { dptr in
                            dptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                                Darwin.sendto(self.sock, cstr, strlen(cstr), 0,
                                              sa, socklen_t(MemoryLayout<sockaddr_in>.size))
                            }
                        }
                    }
                    // Read with 200ms timeout via select() — keep this
                    // simple so we don't have to manage a separate
                    // recv loop just for discovery.
                    var tv = timeval(tv_sec: 0, tv_usec: 200_000)
                    var rfds = fd_set()
                    fdSet(self.sock, &rfds)
                    let r = withUnsafeMutablePointer(to: &rfds) { rfdsPtr in
                        Darwin.select(self.sock + 1, rfdsPtr, nil, nil, &tv)
                    }
                    if r > 0 {
                        var buf = [UInt8](repeating: 0, count: 1500)
                        var src = sockaddr_in()
                        var slen = socklen_t(MemoryLayout<sockaddr_in>.size)
                        let n = buf.withUnsafeMutableBufferPointer { bp in
                            withUnsafeMutablePointer(to: &src) { sp in
                                sp.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                                    Darwin.recvfrom(self.sock, bp.baseAddress, bp.count, 0, sa, &slen)
                                }
                            }
                        }
                        if n > 0 {
                            let s = String(bytes: buf.prefix(n), encoding: .utf8) ?? ""
                            if let ep = Self.parseDiscoverReply(s) {
                                cont.resume(returning: ep)
                                return
                            }
                        } else if n < 0 {
                            lastErr = String(cString: strerror(errno))
                        }
                    }
                }
                AppLog.log("[P2P] discovery timed out (lastErr=\(lastErr))")
                cont.resume(throwing: P2PError.discoveryTimeout)
            }
        }
    }

    private static func parseDiscoverReply(_ s: String) -> Endpoint? {
        guard s.contains("\"DISCOVER_REPLY\"") else { return nil }
        guard let data = s.data(using: .utf8),
              let obj  = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        let ip   = obj["public_ip"] as? String ?? ""
        let port = (obj["public_port"] as? Int).map(UInt16.init(truncatingIfNeeded:)) ?? 0
        guard !ip.isEmpty, port > 0 else { return nil }
        return Endpoint(ip: ip, port: port)
    }

    /// First non-loopback IPv4 from the device's interface list.
    /// Used as the `local_ip` slot in REGISTER_AUDIO_ADDR — peers on
    /// the same LAN can hole-punch via this address with one fewer
    /// hop. Returns "0.0.0.0" if nothing is up; the server still
    /// echoes it but same-LAN peers fall back to public-only.
    private func currentLocalAddress() -> Endpoint {
        var ip = "0.0.0.0"
        var ifap: UnsafeMutablePointer<ifaddrs>? = nil
        if getifaddrs(&ifap) == 0, let head = ifap {
            var p = Optional(head)
            while let cur = p {
                if let addr = cur.pointee.ifa_addr, addr.pointee.sa_family == sa_family_t(AF_INET) {
                    let name = String(cString: cur.pointee.ifa_name)
                    if !name.hasPrefix("lo") && !name.hasPrefix("utun") && !name.hasPrefix("awdl") {
                        var hostBuf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                        if getnameinfo(addr,
                                       socklen_t(MemoryLayout<sockaddr_in>.size),
                                       &hostBuf, socklen_t(NI_MAXHOST),
                                       nil, 0, NI_NUMERICHOST) == 0 {
                            ip = String(cString: hostBuf)
                            break
                        }
                    }
                }
                p = cur.pointee.ifa_next
            }
            freeifaddrs(ifap)
        }
        return Endpoint(ip: ip, port: localPort)
    }

    // MARK: - Receive loop

    private func startReceiveLoop() {
        let t = Thread { [weak self] in
            self?.runReceiveLoop()
        }
        t.name = "io.tonel.p2p.recv"
        t.qualityOfService = .userInteractive
        recvThread = t
        t.start()
    }

    private func runReceiveLoop() {
        var buf = [UInt8](repeating: 0, count: 1500)
        while !Thread.current.isCancelled, sock >= 0 {
            var src = sockaddr_in()
            var slen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let n = buf.withUnsafeMutableBufferPointer { bp in
                withUnsafeMutablePointer(to: &src) { sp in
                    sp.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                        Darwin.recvfrom(sock, bp.baseAddress, bp.count, 0, sa, &slen)
                    }
                }
            }
            if n <= 0 { continue }
            let data = Data(bytes: buf, count: n)
            handleInbound(data, src: src)
        }
    }

    private func handleInbound(_ data: Data, src: sockaddr_in) {
        guard let h = SPA1.parseHeader(data) else { return }

        // Identify the source peer — first try matching the senderId
        // string in the SPA1 userId field; fall back to source addr.
        let senderUid = h.userId
        // Strip "roomId:" prefix to get the bare userId.
        let bareUid: String
        if let colon = senderUid.firstIndex(of: ":") {
            bareUid = String(senderUid[senderUid.index(after: colon)...])
        } else {
            bareUid = senderUid
        }
        if bareUid.isEmpty || bareUid == userId { return }   // ignore loopback

        // Lock in the source addr as the working route for this peer.
        peersLock.lock()
        if var peer = peers[bareUid] {
            if peer.working == nil {
                peer.working = src
                AppLog.log("[P2P] peer \(bareUid) addr resolved via incoming")
            }
            peer.lastInboundTs = Date().timeIntervalSinceReferenceDate
            peers[bareUid] = peer
        }
        peersLock.unlock()

        switch h.codec {
        case .pcm16:
            // Hand over to subscribers — same shape as MixerClient.
            let pcm = SPA1.payload(of: data, header: h)
            let mp  = MixerPacket(userId: senderUid,   // composite "room:user"
                                  sequence: h.sequence,
                                  timestamp: h.timestamp,
                                  pcm: pcm)
            for (_, handler) in packetHandlers { handler(mp) }
        case .peerHello:
            // First contact / hole-punch reply. Already handled the
            // addr-locking above; nothing more to do.
            break
        case .peerPing:
            // RTT estimation: timestamp echo, same as mixer broadcasts.
            let nowLow16 = UInt16((Int(Date().timeIntervalSince1970 * 10)) & 0xFFFF)
            let delta = (nowLow16 &- h.timestamp)
            let rtt = Int(delta) * 100   // 100 ms units → ms
            if rtt >= 0 && rtt < 10_000 {
                audioRttMs = rtt
            }
        default:
            break
        }
    }

    // MARK: - Hole-punch + keepalive

    /// Send `peerHello` to every peer that hasn't yet got a working
    /// addr. Fires every 100 ms via main RunLoop. Stops sending to a
    /// peer once its `working` is non-nil (audio sends prime the NAT
    /// mapping after that). New peers (PEER_ADDR arrives mid-session)
    /// get picked up the next tick.
    private func startHolePunchTimer() {
        holePunchTimer?.invalidate()
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.tickHolePunch()
        }
        RunLoop.main.add(timer, forMode: .common)
        holePunchTimer = timer
    }

    private func tickHolePunch() {
        guard sock >= 0 else { return }
        let hello = SPA1.build(payload: Data(), codec: .peerHello,
                               sequence: 0, timestamp: 0, userId: userIdKey)
        peersLock.lock()
        let pending = peers.values.filter { $0.working == nil }
        peersLock.unlock()
        for peer in pending {
            var pub = peer.publicAddr
            var loc = peer.localAddr
            sendQueue.async { [weak self] in
                self?.sendDatagram(hello, to: &pub)
                self?.sendDatagram(hello, to: &loc)
            }
        }
    }

    /// `peerPing` every 5 s to keep NAT mappings warm. Also fans out
    /// the timestamp echo so the EMA RTT in `audioRttMs` keeps fresh
    /// even when there's no audio sending (mic muted).
    private func startKeepaliveTimer() {
        keepaliveTimer?.invalidate()
        let timer = Timer(timeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.tickKeepalive()
        }
        RunLoop.main.add(timer, forMode: .common)
        keepaliveTimer = timer
    }

    private func tickKeepalive() {
        guard sock >= 0 else { return }
        let ts = UInt16((Int(Date().timeIntervalSince1970 * 10)) & 0xFFFF)
        let ping = SPA1.build(payload: Data(), codec: .peerPing,
                              sequence: 0, timestamp: ts, userId: userIdKey)
        peersLock.lock()
        let snapshot = Array(peers.values)
        peersLock.unlock()
        for peer in snapshot {
            if var w = peer.working {
                sendQueue.async { [weak self] in
                    self?.sendDatagram(ping, to: &w)
                }
            }
        }
    }

    private func sendDatagram(_ data: Data, to addr: inout sockaddr_in) {
        guard sock >= 0 else { return }
        _ = data.withUnsafeBytes { buf -> Int in
            withUnsafePointer(to: &addr) { ap in
                ap.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                    Darwin.sendto(self.sock, buf.baseAddress, buf.count, 0,
                                  sa, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
    }

    // MARK: - Signal-layer handlers

    private func handleSignalMessage(_ msg: SignalMessage) {
        switch msg {
        case let .peerAddr(uid, pubIP, pubPort, locIP, locPort):
            guard !uid.isEmpty, uid != userId else { return }
            var pub = sockaddr_in()
            pub.sin_family = sa_family_t(AF_INET)
            pub.sin_port = pubPort.bigEndian
            pub.sin_addr.s_addr = inet_addr(pubIP)
            var loc = sockaddr_in()
            loc.sin_family = sa_family_t(AF_INET)
            loc.sin_port = locPort.bigEndian
            loc.sin_addr.s_addr = inet_addr(locIP.isEmpty ? "0.0.0.0" : locIP)
            peersLock.lock()
            if peers[uid] == nil {
                peers[uid] = Peer(userId: uid, publicAddr: pub, localAddr: loc, working: nil)
                AppLog.log("[P2P] peer added \(uid) public=\(pubIP):\(pubPort) local=\(locIP):\(locPort)")
            } else {
                // Re-register after reconnect; refresh addr but keep
                // any existing working route until a hole-punch on
                // the new addr succeeds. Conservative.
                peers[uid]?.publicAddr = pub
                peers[uid]?.localAddr  = loc
            }
            peersLock.unlock()
        case let .peerLeft(uid):
            peersLock.lock()
            peers.removeValue(forKey: uid)
            peersLock.unlock()
            AppLog.log("[P2P] peer removed \(uid)")
        default:
            break
        }
    }
}

// MARK: - fd_set shim

/// Swift doesn't expose `FD_SET` macros from `<sys/select.h>`. Tiny
/// helper that sets a bit in the `fds_bits` C array. We only need
/// the SET (no CLR / ZERO / ISSET) for the discovery select.
private func fdSet(_ fd: Int32, _ set: inout fd_set) {
    let intOffset = Int(fd / 32)
    let bitOffset: Int32 = fd % 32
    let mask: Int32 = 1 << bitOffset
    withUnsafeMutablePointer(to: &set.fds_bits) { p in
        p.withMemoryRebound(to: Int32.self, capacity: 32) { ptr in
            ptr[intOffset] |= mask
        }
    }
}
