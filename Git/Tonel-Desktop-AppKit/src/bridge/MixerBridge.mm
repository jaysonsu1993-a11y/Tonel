// MixerBridge.mm — TCP control + UDP audio transport to Tonel mixer server
//
// Connects to the mixer server (TCP:9002 for MIXER_JOIN/LEAVE, UDP:9003 for
// SPA1 audio packets). Audio is sent as mono PCM16 at 48kHz, 240 samples per
// packet (5ms). Mixed audio is received via UDP and stored in a lock-free
// ring buffer for the audio thread to consume.

#import "MixerBridge.h"
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <atomic>
#include <cstring>
#include <string>

// ── SPA1 P1-1 header (76 bytes) ─────────────────────────────────────────────

static constexpr uint32_t kSPA1Magic      = 0x53415031u;
static constexpr size_t   kSPA1HeaderSize = 76;
static constexpr size_t   kMaxPayload     = 1356;

#pragma pack(push, 1)
struct SPA1Header {
    uint32_t magic;          // [0-3]   0x53415031 BE
    uint16_t sequence;       // [4-5]   packet sequence number BE
    uint16_t timestamp;      // [6-7]   playback timestamp BE
    uint8_t  userId[64];     // [8-71]  "roomId:userId" null-terminated
    uint8_t  codec;          // [72]    0=PCM16, 1=Opus, 0xFF=Handshake
    uint16_t dataSize;       // [73-74] payload bytes BE
    uint8_t  reserved;       // [75]
};
#pragma pack(pop)

static_assert(sizeof(SPA1Header) == 76, "SPA1 header must be 76 bytes");

// ── Lock-free SPSC ring buffer ───────────────────────────────────────────────

static constexpr int kRingSize = 48000;  // 1 second @ 48kHz

struct RingBuffer {
    float data[kRingSize];
    std::atomic<int> writePos{0};
    std::atomic<int> readPos{0};

    int available() const {
        int w = writePos.load(std::memory_order_acquire);
        int r = readPos.load(std::memory_order_acquire);
        return (w - r + kRingSize) % kRingSize;
    }

    int space() const {
        return kRingSize - 1 - available();
    }

    void write(const float* src, int count) {
        int w = writePos.load(std::memory_order_relaxed);
        for (int i = 0; i < count; i++) {
            data[w] = src[i];
            w = (w + 1) % kRingSize;
        }
        writePos.store(w, std::memory_order_release);
    }

    int read(float* dst, int count) {
        int avail = available();
        int toRead = (count < avail) ? count : avail;
        int r = readPos.load(std::memory_order_relaxed);
        for (int i = 0; i < toRead; i++) {
            dst[i] = data[r];
            r = (r + 1) % kRingSize;
        }
        readPos.store(r, std::memory_order_release);
        return toRead;
    }

    void reset() {
        writePos.store(0, std::memory_order_release);
        readPos.store(0, std::memory_order_release);
    }
};

// ── Mixer server address ─────────────────────────────────────────────────────

static const char* kMixerHost    = "8.163.21.207";
static const int   kMixerTCPPort = 9002;
static const int   kMixerUDPPort = 9003;

// ── MixerBridge implementation ───────────────────────────────────────────────

@implementation MixerBridge {
    int _tcpSock;
    int _udpSock;

    dispatch_queue_t  _connectQueue;
    dispatch_queue_t  _udpRecvQueue;
    dispatch_source_t _udpSource;

    RingBuffer _rxRing;

    std::string _roomId;
    std::string _userId;
    std::string _userIdKey;   // "roomId:userId"

    std::atomic<uint16_t> _sequence;
    std::atomic<bool>     _connected;

    struct sockaddr_in _mixerUDPAddr;
}

+ (instancetype)shared {
    static MixerBridge* inst;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ inst = [[MixerBridge alloc] init]; });
    return inst;
}

- (instancetype)init {
    if (self = [super init]) {
        _tcpSock      = -1;
        _udpSock      = -1;
        _sequence     = 0;
        _connected    = false;
        _connectQueue = dispatch_queue_create("com.tonel.mixer.connect", DISPATCH_QUEUE_SERIAL);
        _udpRecvQueue = dispatch_queue_create("com.tonel.mixer.udp.recv", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

// ── Public API ───────────────────────────────────────────────────────────────

- (void)connectToRoom:(NSString*)roomId userId:(NSString*)userId {
    _roomId    = roomId.UTF8String;
    _userId    = userId.UTF8String;
    _userIdKey = _roomId + ":" + _userId;
    _sequence  = 0;
    _rxRing.reset();

    dispatch_async(_connectQueue, ^{
        [self doConnect];
    });
}

- (void)disconnect {
    bool wasConnected = _connected.exchange(false);

    // Send MIXER_LEAVE before closing
    if (_tcpSock >= 0 && wasConnected) {
        std::string leaveMsg = "{\"type\":\"MIXER_LEAVE\",\"room_id\":\"" + _roomId
                             + "\",\"user_id\":\"" + _userId + "\"}\n";
        ::send(_tcpSock, leaveMsg.c_str(), leaveMsg.size(), 0);
        NSLog(@"[MixerBridge] Sent MIXER_LEAVE");
    }

    if (_udpSource) {
        dispatch_source_cancel(_udpSource);
        _udpSource = nil;
    }
    if (_udpSock >= 0) { close(_udpSock); _udpSock = -1; }
    if (_tcpSock >= 0) { close(_tcpSock); _tcpSock = -1; }

    _rxRing.reset();
    NSLog(@"[MixerBridge] Disconnected");
}

- (BOOL)isConnected {
    return (BOOL)_connected.load(std::memory_order_acquire);
}

// ── Audio thread interface (lock-free) ───────────────────────────────────────

- (void)sendAudioSamples:(const int16_t*)samples count:(int)count {
    if (!_connected.load(std::memory_order_acquire) || _udpSock < 0) return;

    size_t dataSize = count * sizeof(int16_t);
    if (dataSize > kMaxPayload) return;

    // DEBUG
    static int sendCount = 0;
    if (sendCount < 5 || sendCount % 1000 == 0) {
        NSLog(@"[MixerBridge] sendAudio #%d count=%d dataSize=%zu", sendCount, count, dataSize);
    }
    sendCount++;

    uint8_t pkt[kSPA1HeaderSize + kMaxPayload];
    SPA1Header* h = reinterpret_cast<SPA1Header*>(pkt);

    uint16_t seq = _sequence.fetch_add(1, std::memory_order_relaxed);

    h->magic     = htonl(kSPA1Magic);
    h->sequence  = htons(seq);
    h->timestamp = 0;
    std::memset(h->userId, 0, 64);
    std::strncpy(reinterpret_cast<char*>(h->userId), _userIdKey.c_str(), 63);
    h->codec     = 0;   // PCM16
    h->dataSize  = htons(static_cast<uint16_t>(dataSize));
    h->reserved  = 0;

    std::memcpy(pkt + kSPA1HeaderSize, samples, dataSize);

    sendto(_udpSock, pkt, kSPA1HeaderSize + dataSize, 0,
           reinterpret_cast<const struct sockaddr*>(&_mixerUDPAddr),
           sizeof(_mixerUDPAddr));
}

- (int)readMixedAudio:(float*)output maxSamples:(int)maxSamples {
    return _rxRing.read(output, maxSamples);
}

// ── Internal: connection sequence ────────────────────────────────────────────

- (void)doConnect {
    // ── 1. TCP connect to mixer control channel ──────────────────────────
    _tcpSock = socket(AF_INET, SOCK_STREAM, 0);
    if (_tcpSock < 0) {
        [self notifyError:@"Failed to create TCP socket"]; return;
    }

    // Set TCP connect timeout (5 seconds)
    struct timeval tv = { .tv_sec = 5, .tv_usec = 0 };
    setsockopt(_tcpSock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    setsockopt(_tcpSock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    struct sockaddr_in tcpAddr{};
    tcpAddr.sin_family = AF_INET;
    tcpAddr.sin_port   = htons(kMixerTCPPort);
    inet_pton(AF_INET, kMixerHost, &tcpAddr.sin_addr);

    if (connect(_tcpSock, reinterpret_cast<struct sockaddr*>(&tcpAddr), sizeof(tcpAddr)) < 0) {
        close(_tcpSock); _tcpSock = -1;
        [self notifyError:@"无法连接到混音服务器"]; return;
    }
    NSLog(@"[MixerBridge] TCP connected to %s:%d", kMixerHost, kMixerTCPPort);

    // ── 2. Send MIXER_JOIN ───────────────────────────────────────────────
    std::string joinMsg = "{\"type\":\"MIXER_JOIN\",\"room_id\":\"" + _roomId
                        + "\",\"user_id\":\"" + _userId + "\"}\n";
    ::send(_tcpSock, joinMsg.c_str(), joinMsg.size(), 0);
    NSLog(@"[MixerBridge] Sent MIXER_JOIN room=%s user=%s", _roomId.c_str(), _userId.c_str());

    // ── 3. Read MIXER_JOIN_ACK ───────────────────────────────────────────
    char buf[1024] = {0};
    ssize_t n = recv(_tcpSock, buf, sizeof(buf) - 1, 0);
    if (n <= 0) {
        close(_tcpSock); _tcpSock = -1;
        [self notifyError:@"混音服务器无响应"]; return;
    }
    NSLog(@"[MixerBridge] ACK: %s", buf);

    // Parse udp_port from ACK
    int udpPort = kMixerUDPPort;
    std::string resp(buf, static_cast<size_t>(n));
    auto pos = resp.find("\"udp_port\":");
    if (pos != std::string::npos) {
        udpPort = atoi(resp.c_str() + pos + 11);
    }

    // ── 4. Create UDP socket ─────────────────────────────────────────────
    _udpSock = socket(AF_INET, SOCK_DGRAM, 0);
    if (_udpSock < 0) {
        close(_tcpSock); _tcpSock = -1;
        [self notifyError:@"Failed to create UDP socket"]; return;
    }

    // Bind to any local port
    struct sockaddr_in localAddr{};
    localAddr.sin_family      = AF_INET;
    localAddr.sin_addr.s_addr = INADDR_ANY;
    localAddr.sin_port        = 0;
    bind(_udpSock, reinterpret_cast<struct sockaddr*>(&localAddr), sizeof(localAddr));

    // Mixer UDP destination
    std::memset(&_mixerUDPAddr, 0, sizeof(_mixerUDPAddr));
    _mixerUDPAddr.sin_family = AF_INET;
    _mixerUDPAddr.sin_port   = htons(udpPort);
    inet_pton(AF_INET, kMixerHost, &_mixerUDPAddr.sin_addr);

    // ── 5. Send SPA1 HANDSHAKE to register our UDP address ──────────────
    [self sendHandshake];

    _connected.store(true, std::memory_order_release);

    // ── 6. Start UDP receive loop ────────────────────────────────────────
    [self startUDPReceive];

    // ── 7. Start TCP read loop (for LEVELS, errors, etc.) ────────────────
    [self startTCPReadLoop];

    // ── 8. Notify delegate on main thread ────────────────────────────────
    dispatch_async(dispatch_get_main_queue(), ^{
        NSLog(@"[MixerBridge] Fully connected, UDP port=%d", udpPort);
        if ([self.delegate respondsToSelector:@selector(mixerBridgeConnected)])
            [self.delegate mixerBridgeConnected];
    });
}

- (void)sendHandshake {
    uint8_t pkt[kSPA1HeaderSize];
    std::memset(pkt, 0, sizeof(pkt));

    SPA1Header* h = reinterpret_cast<SPA1Header*>(pkt);
    h->magic    = htonl(kSPA1Magic);
    h->sequence = 0;
    h->timestamp = 0;
    std::strncpy(reinterpret_cast<char*>(h->userId), _userIdKey.c_str(), 63);
    h->codec    = 0xFF;  // Handshake
    h->dataSize = 0;
    h->reserved = 0;

    sendto(_udpSock, pkt, kSPA1HeaderSize, 0,
           reinterpret_cast<const struct sockaddr*>(&_mixerUDPAddr),
           sizeof(_mixerUDPAddr));
    NSLog(@"[MixerBridge] Sent HANDSHAKE for %s", _userIdKey.c_str());
}

// ── UDP receive (GCD dispatch source) ────────────────────────────────────────

- (void)startUDPReceive {
    int sock = _udpSock;
    dispatch_source_t source = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_READ, static_cast<uintptr_t>(sock), 0, _udpRecvQueue);
    _udpSource = source;

    __weak MixerBridge* weakSelf = self;

    dispatch_source_set_event_handler(source, ^{
        MixerBridge* strongSelf = weakSelf;
        if (!strongSelf) return;

        uint8_t buf[2048];
        struct sockaddr_in from{};
        socklen_t fromLen = sizeof(from);
        ssize_t n = recvfrom(sock, buf, sizeof(buf), 0,
                             reinterpret_cast<struct sockaddr*>(&from), &fromLen);
        if (n < static_cast<ssize_t>(kSPA1HeaderSize)) return;

        const SPA1Header* h = reinterpret_cast<const SPA1Header*>(buf);
        if (ntohl(h->magic) != kSPA1Magic) return;

        uint8_t  codec   = h->codec;
        uint16_t dataSz  = ntohs(h->dataSize);

        if (codec == 0xFF) return;  // handshake echo, ignore
        if (static_cast<size_t>(n) < kSPA1HeaderSize + dataSz) return;

        const uint8_t* audioData = buf + kSPA1HeaderSize;

        if (codec == 0) {  // PCM16 mono
            int sampleCount = dataSz / static_cast<int>(sizeof(int16_t));
            if (sampleCount > 1024) sampleCount = 1024;
            const int16_t* pcm = reinterpret_cast<const int16_t*>(audioData);
            float floatBuf[1024];
            for (int i = 0; i < sampleCount; i++) {
                floatBuf[i] = pcm[i] / 32768.0f;
            }
            // DEBUG
            static int rxCount = 0;
            if (rxCount < 5 || rxCount % 1000 == 0) {
                NSLog(@"[MixerBridge] UDP rx #%d samples=%d ringAvail=%d", rxCount, sampleCount, strongSelf->_rxRing.available());
            }
            rxCount++;

            if (strongSelf->_rxRing.space() >= sampleCount) {
                strongSelf->_rxRing.write(floatBuf, sampleCount);
            }
        }
        // Opus decode could be added here if needed
    });

    dispatch_resume(source);
}

// ── TCP read loop (background, for LEVELS messages) ──────────────────────────

- (void)startTCPReadLoop {
    int sock = _tcpSock;
    __weak MixerBridge* weakSelf = self;

    dispatch_async(_connectQueue, ^{
        // Remove the send timeout so recv can block waiting for data
        struct timeval tv = { .tv_sec = 0, .tv_usec = 0 };
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

        char buf[4096];
        while (true) {
            MixerBridge* strongSelf = weakSelf;
            if (!strongSelf || !strongSelf->_connected.load(std::memory_order_acquire)) break;

            ssize_t n = recv(sock, buf, sizeof(buf) - 1, 0);
            if (n <= 0) {
                MixerBridge* s2 = weakSelf;
                if (s2 && s2->_connected.exchange(false)) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        MixerBridge* s3 = weakSelf;
                        if (s3 && [s3.delegate respondsToSelector:@selector(mixerBridgeDisconnected)])
                            [s3.delegate mixerBridgeDisconnected];
                    });
                }
                break;
            }
            // LEVELS messages are received here; could parse and update UI
            // For now just consume them silently
        }
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

- (void)notifyError:(NSString*)msg {
    NSLog(@"[MixerBridge] Error: %@", msg);
    dispatch_async(dispatch_get_main_queue(), ^{
        if ([self.delegate respondsToSelector:@selector(mixerBridgeError:)])
            [self.delegate mixerBridgeError:msg];
    });
}

@end
