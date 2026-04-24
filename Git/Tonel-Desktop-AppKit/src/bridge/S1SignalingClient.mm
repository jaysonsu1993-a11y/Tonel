// S1SignalingClient.mm — WebSocket signaling for macOS 10.15+ (NSURLSessionWebSocketTask)
// Connects through nginx proxy: wss://tonel.io/signaling → ws-proxy:9004 → signaling:9001

#import <Foundation/Foundation.h>
#include "S1SignalingClient.h"

// ── WebSocket delegate ──────────────────────────────────────────────────────

@interface WSClientDelegate : NSObject <NSURLSessionWebSocketDelegate>
@property (nonatomic, assign) S1SignalingClient* cpp;
@end

@implementation WSClientDelegate {
    dispatch_queue_t _q;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _q = dispatch_queue_create("com.s1.wsr", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (void)URLSession:(NSURLSession *)session
      webSocketTask:(NSURLSessionWebSocketTask *)task
 didOpenWithProtocol:(NSString *)protocol
API_AVAILABLE(macos(10.15)) {
    if (self.cpp) {
        self.cpp->onSignalingConnected();
        [self recv:task];
    }
}

- (void)URLSession:(NSURLSession *)session
      webSocketTask:(NSURLSessionWebSocketTask *)task
   didCloseWithCode:(NSURLSessionWebSocketCloseCode)code
             reason:(NSData *)reason
API_AVAILABLE(macos(10.15)) {
    if (self.cpp) self.cpp->onDisconnect();
}

- (void)recv:(NSURLSessionWebSocketTask*)task {
    __weak WSClientDelegate* ws = self;
    dispatch_async(_q, ^{
        __strong WSClientDelegate* w = ws;
        if (!w) { NSLog(@"[WS] recv: delegate gone"); return; }
        if (!w.cpp) { NSLog(@"[WS] recv: cppClient is nil"); return; }
        NSLog(@"[WS] recv waiting for message...");
        [task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage * _Nullable msg, NSError * _Nullable err) {
            __strong WSClientDelegate* w2 = ws;
            if (!w2) return;
            if (err) {
                NSLog(@"[WS] recv error: %@", err);
                if (w2.cpp) w2.cpp->onDisconnect();
                return;
            }
            if (msg && msg.string.length > 0 && w2.cpp) {
                NSLog(@"[WS] recv msg: %.80s", msg.string.UTF8String);
                w2.cpp->onMessage(msg.string.UTF8String);
            }
            [w2 recv:task];
        }];
    });
}

// Delegate: called when the task fails before opening
- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didCompleteWithError:(nullable NSError *)error
API_AVAILABLE(macos(10.15)) {
    if (error) {
        NSLog(@"[WS] task failed: %@", error);
    } else {
        NSLog(@"[WS] task completed (no error)");
    }
    if (self.cpp) {
        if (error) {
            NSString* msg = error.localizedDescription;
            std::string err(msg.UTF8String);
            self.cpp->onSignalingError(err);
        }
        self.cpp->onDisconnect();
    }
}

@end

// ── URL helper ──────────────────────────────────────────────────────────────

static NSURL* wsURL(const std::string& host, int port) {
    NSString* h = [NSString stringWithUTF8String:host.c_str()];
    if (port == 443)
        return [NSURL URLWithString:[NSString stringWithFormat:@"wss://%@/signaling", h]];
    return [NSURL URLWithString:[NSString stringWithFormat:@"wss://%@:%d/signaling", h, port]];
}

// ── S1SignalingClient ───────────────────────────────────────────────────────

S1SignalingClient::S1SignalingClient()  = default;
S1SignalingClient::~S1SignalingClient() { disconnect(); }

bool S1SignalingClient::connect(const std::string& host, int port) {
    @autoreleasepool {
        NSURL* url = wsURL(host, port);
        NSLog(@"[S1Signaling] WebSocket: %@", url);

        WSClientDelegate* del = [[WSClientDelegate alloc] init];
        del.cpp = this;

        NSURLSessionConfiguration* cfg = [NSURLSessionConfiguration defaultSessionConfiguration];
        cfg.waitsForConnectivity = YES;
        NSURLSession* sess = [NSURLSession sessionWithConfiguration:cfg delegate:del delegateQueue:nil];
        NSURLSessionWebSocketTask* task = [sess webSocketTaskWithURL:url];

        NSLog(@"[S1Signaling] task created, resuming...");
        [task resume];

        pimpl_ = new WSClientPimpl{ del, sess, task };
        return true;
    }
}

void S1SignalingClient::disconnect() {
    connected_.store(false, std::memory_order_release);
    if (!pimpl_) return;
    WSClientPimpl* p = pimpl_;
    @autoreleasepool {
        [p->task cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil];
        [p->session invalidateAndCancel];
        p->delegate = nil;
    }
    delete p;
    pimpl_ = nullptr;
}

void S1SignalingClient::createRoom(const std::string& roomId, const std::string& userId,
                                    const std::string& password) {
    std::string m = "{\"type\":\"CREATE_ROOM\"," + jsonString("room_id",roomId) + ","
                  + jsonString("user_id",userId);
    if (!password.empty()) m += "," + jsonString("password",password);
    m += "}";
    send(m);
}

void S1SignalingClient::joinRoom(const std::string& roomId, const std::string& userId,
                                  const std::string& localIp, int localPort,
                                  const std::string& password) {
    std::string m = "{\"type\":\"JOIN_ROOM\"," + jsonString("room_id",roomId) + ","
                  + jsonString("user_id",userId) + ","
                  + jsonString("ip",localIp.empty()?"0.0.0.0":localIp) + ","
                  + jsonInt("port",localPort);
    if (!password.empty()) m += "," + jsonString("password",password);
    m += "}";
    send(m);
}

void S1SignalingClient::leaveRoom(const std::string& roomId, const std::string& userId) {
    send("{\"type\":\"LEAVE_ROOM\"," + jsonString("room_id",roomId) + ","
                  + jsonString("user_id",userId) + "}");
}

void S1SignalingClient::onMessage(const std::string& json) { processLine(json); }

void S1SignalingClient::onSignalingError(const std::string& error) {
    NSLog(@"[S1Signaling] error: %s", error.c_str());
    if (callback_) callback_->onSignalingError(error);
}

void S1SignalingClient::onDisconnect() {
    bool was = connected_.exchange(false, std::memory_order_acq_rel);
    if (was && callback_) callback_->onSignalingDisconnected();
}

void S1SignalingClient::onSignalingConnected() {
    NSLog(@"[S1Signaling] connected!");
    connected_.store(true, std::memory_order_release);
    if (callback_) callback_->onSignalingConnected();
}

void S1SignalingClient::send(const std::string& msg) {
    std::lock_guard<std::mutex> lk(sendMutex_);
    if (!pimpl_ || !connected_.load()) return;
    WSClientPimpl* p = pimpl_;
    @autoreleasepool {
        NSString* d = [NSString stringWithUTF8String:msg.c_str()];
        NSURLSessionWebSocketMessage* wm = [[NSURLSessionWebSocketMessage alloc] initWithString:d];
        __weak NSURLSessionWebSocketTask* wt = p->task;
        (void)wt; // suppress unused variable warning
        S1SignalingClient* raw = this;
        [p->task sendMessage:wm completionHandler:^(NSError* _Nullable e) {
            if (e) {
                raw->connected_.exchange(false, std::memory_order_acq_rel);
                std::string err = std::string("send: ") + e.localizedDescription.UTF8String;
                if (raw->callback_) raw->callback_->onSignalingError(err);
            }
        }];
    }
}

// ── JSON parsing ────────────────────────────────────────────────────────────

void S1SignalingClient::processLine(const std::string& json) {
    std::string type = extractStr(json, "type");
    if (type == "CREATE_ROOM_ACK") {
        if (callback_) callback_->onRoomCreated(extractStr(json, "room_id"));
    } else if (type == "JOIN_ROOM_ACK") {
        if (callback_) callback_->onRoomJoined(extractStr(json, "room_id"));
    } else if (type == "PEER_LIST") {
        if (callback_) callback_->onPeerList(extractStr(json, "room_id"), extractPeers(json));
    } else if (type == "PEER_JOINED") {
        S1PeerInfo pi;
        pi.user_id = extractStr(json,"user_id");
        pi.ip      = extractStr(json,"ip");
        pi.port    = extractInt(json,"port");
        if (callback_) callback_->onPeerJoined(pi);
    } else if (type == "PEER_LEFT") {
        if (callback_) callback_->onPeerLeft(extractStr(json,"user_id"));
    } else if (type == "ERROR") {
        if (callback_) callback_->onSignalingError(extractStr(json,"message"));
    }
}

std::string S1SignalingClient::jsonString(const std::string& k, const std::string& v) const {
    return "\"" + k + "\":\"" + v + "\"";
}

std::string S1SignalingClient::jsonInt(const std::string& k, int v) const {
    return "\"" + k + "\":" + std::to_string(v);
}

std::string S1SignalingClient::extractStr(const std::string& json, const std::string& key) const {
    std::string n = "\"" + key + "\":\"";
    auto p = json.find(n);
    if (p == std::string::npos) return {};
    p += n.size();
    auto e = json.find('"', p);
    if (e == std::string::npos) return {};
    return json.substr(p, e - p);
}

int S1SignalingClient::extractInt(const std::string& json, const std::string& key) const {
    std::string n = "\"" + key + "\":";
    auto p = json.find(n);
    if (p == std::string::npos) return 0;
    p += n.size();
    while (p < json.size() && json[p]==' ') ++p;
    bool neg = false;
    if (p < json.size() && json[p]=='-') { neg=true; ++p; }
    int v = 0;
    while (p < json.size() && json[p]>='0' && json[p]<='9') { v = v*10 + (json[p]-'0'); ++p; }
    return neg ? -v : v;
}

std::vector<S1PeerInfo> S1SignalingClient::extractPeers(const std::string& json) const {
    std::vector<S1PeerInfo> out;
    auto as = json.find("\"peers\":[");
    if (as == std::string::npos) return out;
    as += 9;
    auto ae = json.find(']', as);
    if (ae == std::string::npos) return out;
    std::string arr = json.substr(as, ae - as);
    std::string::size_type i = 0;
    while (i < arr.size()) {
        auto ob = arr.find('{', i);
        if (ob == std::string::npos) break;
        auto oe = arr.find('}', ob);
        if (oe == std::string::npos) break;
        std::string obj = arr.substr(ob, oe - ob + 1);
        S1PeerInfo p;
        p.user_id = extractStr(obj,"user_id");
        p.ip      = extractStr(obj,"ip");
        p.port    = extractInt(obj,"port");
        if (!p.user_id.empty()) out.push_back(p);
        i = oe + 1;
    }
    return out;
}
