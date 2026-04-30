// wt-mixer-proxy — WebTransport ↔ UDP bridge for the Tonel mixer.
//
// Replaces the audio-data leg of ws-mixer-proxy (browser →
// WSS-over-TCP → proxy → UDP → mixer) with QUIC datagrams to kill
// HoL blocking and TCP burst patterns.
//
// One instance handles all browser sessions:
//   - HTTP/3 server on UDP :4433
//   - WebTransport endpoint at /mixer-wt
//   - Each session: client SendDatagram(SPA1 packet) → forwarded to
//     mixer at 127.0.0.1:9003 from a single shared bound UDP port
//     (so the mixer sees one source addr and replies to it for every
//     SPA1 frame regardless of which user it's destined for)
//   - Reverse path: mixer UDP → parse SPA1 userId → demux to the
//     matching WebTransport session → SendDatagram back to browser
//
// The MIXER_JOIN handshake and PING/PONG remain on the WSS control
// channel (ws-mixer-proxy /mixer-tcp) — control traffic isn't
// latency-sensitive and the WS path is already battle-tested.
//
// Cert: TLS cert + key are read from disk at startup. In production
// we point at /etc/letsencrypt/live/srv.tonel.io/{fullchain.pem,privkey.pem}.
//
// Why Go: webtransport-go is the only stable WebTransport server
// implementation that's production-ready. quic-go is the QUIC stack
// it's built on. C++ alternatives (msquic, lsquic) have weaker
// WebTransport support.
package main

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

// SPA1 packet layout (matches Git/web/src/services/audioService.ts and
// Git/server/src/audio_packet.h). Wire format is big-endian.
const (
	spa1Magic       uint32 = 0x53415031 // "SPA1"
	spa1HeaderSize         = 76
	spa1UidOffset          = 8  // userId field starts at byte 8
	spa1UidLen             = 64 // userId is 64 bytes, NUL-padded
	maxDatagramSize        = 1500
)

// extractUid reads the SPA1 userId out of a packet's header. Returns
// "" + false if the packet is too short or has the wrong magic — the
// caller should drop those silently (don't log-spam if the network
// sends junk).
func extractUid(p []byte) (string, bool) {
	if len(p) < spa1HeaderSize {
		return "", false
	}
	if binary.BigEndian.Uint32(p[0:4]) != spa1Magic {
		return "", false
	}
	end := spa1UidOffset
	for end < spa1UidOffset+spa1UidLen && p[end] != 0 {
		end++
	}
	return string(p[spa1UidOffset:end]), true
}

// sessionMap routes mixer-bound UDP packets to the right WebTransport
// session. Mirrors ws-mixer-proxy.js's `wsByUid` map. Keyed by the
// "roomId:userId" string the client puts in the SPA1 header.
//
// Concurrent: one goroutine reads the mixer UDP socket and looks up
// sessions; one goroutine per WT connection writes new entries. RWMutex
// is enough — lookups outnumber writes 1000:1.
type sessionMap struct {
	mu sync.RWMutex
	m  map[string]*webtransport.Session
}

func newSessionMap() *sessionMap {
	return &sessionMap{m: make(map[string]*webtransport.Session)}
}

func (sm *sessionMap) set(uid string, s *webtransport.Session) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	// v4.3.2 fix: if a session was already registered for this uid
	// (e.g. a tab reconnected without the previous one fully closing,
	// or a second device joined as the same user), CLOSE the displaced
	// session. Pre-fix, we just dropped the map reference but the
	// session's read goroutine kept running and forwarding datagrams
	// to the mixer — both sessions streamed to the same userId,
	// confusing the per-recipient mix-minus path on the mixer side.
	// The mixer's session-takeover logic only handled the TCP control
	// channel (`displaced_tcp` in mixer_server.cpp); the UDP audio leg
	// had no equivalent until this fix.
	//
	// Close on a goroutine because CloseWithError can briefly block on
	// QUIC frame send; we don't want to hold the sessionMap lock for
	// that. The displaced session's handleSession will see its
	// ReceiveDatagram error out and self-clean the deferred path.
	if cur, ok := sm.m[uid]; ok && cur != s {
		go func(prev *webtransport.Session) {
			_ = prev.CloseWithError(0, "replaced by new session for same uid")
		}(cur)
	}
	sm.m[uid] = s
}

func (sm *sessionMap) get(uid string) (*webtransport.Session, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	s, ok := sm.m[uid]
	return s, ok
}

func (sm *sessionMap) deleteIfMatches(uid string, s *webtransport.Session) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	// Only delete if the entry is still our session. A racing reconnect
	// from the same uid may have replaced it before we got the close
	// notification — in that case leaving the new entry is correct.
	if cur, ok := sm.m[uid]; ok && cur == s {
		delete(sm.m, uid)
	}
}

func (sm *sessionMap) size() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return len(sm.m)
}

// stats are atomic to avoid mu contention on the hot path.
type stats struct {
	dgramRx     atomic.Uint64 // datagrams received from browsers
	dgramTx     atomic.Uint64 // datagrams sent to browsers
	udpRx       atomic.Uint64 // packets received from mixer
	udpTx       atomic.Uint64 // packets sent to mixer
	noMatch     atomic.Uint64 // mixer packet had uid we don't know
	dropped     atomic.Uint64 // session existed but datagram send failed
}

func main() {
	listenAddr := flag.String("listen", ":4433", "UDP listen address for HTTP/3 / WebTransport")
	certFile := flag.String("cert", "/etc/letsencrypt/live/srv.tonel.io/fullchain.pem", "TLS cert path")
	keyFile := flag.String("key", "/etc/letsencrypt/live/srv.tonel.io/privkey.pem", "TLS key path")
	mixerAddr := flag.String("mixer", "127.0.0.1:9003", "Mixer UDP destination")
	recvPort := flag.Int("recv", 9007, "Local UDP port to bind for mixer return path")
	wtPath := flag.String("path", "/mixer-wt", "WebTransport endpoint path")
	flag.Parse()

	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	// ── 1. Bind UDP socket for mixer relay ────────────────────────────────
	//
	// Single bound port shared across all browser sessions. The mixer
	// needs a stable source address (it learns it from each user's
	// SPA1 handshake) and we demux replies based on the userId in the
	// SPA1 header. Same pattern as ws-mixer-proxy.js's `udpRecv` socket.
	mixerUDPAddr, err := net.ResolveUDPAddr("udp", *mixerAddr)
	if err != nil {
		log.Fatalf("resolve mixer addr: %v", err)
	}
	udpSock, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: *recvPort})
	if err != nil {
		log.Fatalf("bind UDP :%d: %v", *recvPort, err)
	}
	defer udpSock.Close()
	log.Printf("UDP recv socket bound to 127.0.0.1:%d", *recvPort)
	log.Printf("mixer destination: %s", *mixerAddr)

	sessions := newSessionMap()
	st := &stats{}

	// ── 2. Goroutine: read from mixer UDP, route to WT sessions ──────────
	go func() {
		buf := make([]byte, maxDatagramSize)
		for {
			n, _, err := udpSock.ReadFromUDP(buf)
			if err != nil {
				// Socket closed during shutdown is the normal path; any
				// other error is unexpected but we want the proxy to keep
				// trying rather than die — pm2 would just restart it.
				if isClosedErr(err) {
					return
				}
				log.Printf("udpSock.ReadFromUDP: %v", err)
				continue
			}
			st.udpRx.Add(1)
			uid, ok := extractUid(buf[:n])
			if !ok {
				continue
			}
			sess, found := sessions.get(uid)
			if !found {
				st.noMatch.Add(1)
				continue
			}
			// Copy because SendDatagram retains the slice asynchronously
			// in some quic-go internal queues — reusing buf would corrupt
			// pending writes.
			cp := make([]byte, n)
			copy(cp, buf[:n])
			if err := sess.SendDatagram(cp); err != nil {
				st.dropped.Add(1)
				continue
			}
			st.dgramTx.Add(1)
		}
	}()

	// ── 3. Stats ticker (5 s, only logs when there's traffic) ────────────
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for range t.C {
			rx := st.dgramRx.Swap(0)
			tx := st.dgramTx.Swap(0)
			urx := st.udpRx.Swap(0)
			utx := st.udpTx.Swap(0)
			nm := st.noMatch.Swap(0)
			dr := st.dropped.Swap(0)
			if rx == 0 && tx == 0 && urx == 0 && utx == 0 {
				continue
			}
			log.Printf("STATS dgramRx=%d dgramTx=%d udpRx=%d udpTx=%d noMatch=%d dropped=%d sessions=%d",
				rx, tx, urx, utx, nm, dr, sessions.size())
		}
	}()

	// ── 4. WebTransport server ───────────────────────────────────────────
	cert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
	if err != nil {
		log.Fatalf("load cert (%s, %s): %v", *certFile, *keyFile, err)
	}
	tlsConf := &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"h3"},
	}

	wtServer := &webtransport.Server{
		H3: &http3.Server{
			Addr:      *listenAddr,
			TLSConfig: tlsConf,
		},
		// Origin check disabled: the SPA1 handshake itself is
		// authoritative (server validates room/user tokens via the
		// signaling path before MIXER_JOIN succeeds). A strict origin
		// check would also break local dev (file://) and the
		// pages.dev preview deploys.
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	// MUST call before ListenAndServe — sets H3.EnableDatagrams and
	// the SETTINGS_ENABLE_WEBTRANSPORT frame the client looks for in
	// the SETTINGS exchange. Skipping this triggers client-side
	// "server didn't enable HTTP/3 datagram support" — which is what
	// bit us during the v4.0.0 first-fire validation. webtransport-go
	// only auto-configures `quic.Config.EnableDatagrams` inside its
	// own `Serve()`; the H3 layer SETTINGS still need this helper.
	webtransport.ConfigureHTTP3Server(wtServer.H3)

	mux := http.NewServeMux()
	mux.HandleFunc(*wtPath, func(w http.ResponseWriter, r *http.Request) {
		sess, err := wtServer.Upgrade(w, r)
		if err != nil {
			log.Printf("WT upgrade failed: %v", err)
			w.WriteHeader(500)
			return
		}
		log.Printf("WT session opened from %s", r.RemoteAddr)
		handleSession(sess, sessions, st, udpSock, mixerUDPAddr)
	})
	wtServer.H3.Handler = mux

	// ── 5. Run + clean shutdown ──────────────────────────────────────────
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		log.Printf("signal received, shutting down")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = wtServer.Close()
		_ = wtServer.H3.Shutdown(ctx)
		_ = udpSock.Close()
		os.Exit(0)
	}()

	log.Printf("WebTransport server listening on %s, path=%s", *listenAddr, *wtPath)
	if err := wtServer.ListenAndServe(); err != nil {
		log.Fatalf("ListenAndServe: %v", err)
	}
}

// handleSession runs one browser session: forward each datagram from
// the client to the mixer's UDP socket. Returns when the client
// closes or the session errors out.
func handleSession(
	sess *webtransport.Session,
	sessions *sessionMap,
	st *stats,
	udpSock *net.UDPConn,
	mixerAddr *net.UDPAddr,
) {
	var registeredUid string
	defer func() {
		if registeredUid != "" {
			sessions.deleteIfMatches(registeredUid, sess)
			log.Printf("WT session closed: uid=%s", registeredUid)
		} else {
			log.Printf("WT session closed (never registered)")
		}
		_ = sess.CloseWithError(0, "")
	}()

	ctx := sess.Context()
	for {
		data, err := sess.ReceiveDatagram(ctx)
		if err != nil {
			return
		}
		st.dgramRx.Add(1)

		// First valid SPA1 packet registers the uid → session mapping.
		// All subsequent packets just forward to the mixer; the mixer
		// already learned the source addr from the handshake packet
		// and will reply to it.
		if registeredUid == "" {
			if uid, ok := extractUid(data); ok {
				registeredUid = uid
				sessions.set(uid, sess)
				log.Printf("WT session registered: uid=%s", uid)
			}
		}

		if _, err := udpSock.WriteToUDP(data, mixerAddr); err != nil {
			log.Printf("udpSock.WriteToUDP: %v", err)
			continue
		}
		st.udpTx.Add(1)
	}
}

// isClosedErr matches the wrapped "use of closed network connection"
// error returned by net.UDPConn.ReadFromUDP after Close. Go's net
// package doesn't export a sentinel for this so we check the message.
func isClosedErr(err error) bool {
	if err == nil {
		return false
	}
	return err.Error() == "use of closed network connection" ||
		err.Error() == "EOF"
}
