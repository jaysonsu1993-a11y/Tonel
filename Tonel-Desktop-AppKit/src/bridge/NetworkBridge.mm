// NetworkBridge.mm — ObjC bridge to S1SignalingClient (POSIX TCP)
#import "NetworkBridge.h"
#include "S1SignalingClient.h"
#include <memory>

// ── C++ → ObjC callback adapter ───────────────────────────────────────────────

class SignalingCallbackAdapter : public S1SignalingCallback {
public:
    explicit SignalingCallbackAdapter(__weak NetworkBridge* bridge)
        : bridge_(bridge) {}

    void onSignalingConnected() override {
        dispatch_async(dispatch_get_main_queue(), ^{
            NetworkBridge* b = bridge_;
            if (!b) return;
            id<NetworkBridgeDelegate> d = b.delegate;
            if ([d respondsToSelector:@selector(networkBridgeConnected)])
                [d networkBridgeConnected];
        });
    }

    void onSignalingDisconnected() override {
        dispatch_async(dispatch_get_main_queue(), ^{
            NetworkBridge* b = bridge_;
            if (!b) return;
            id<NetworkBridgeDelegate> d = b.delegate;
            if ([d respondsToSelector:@selector(networkBridgeDisconnected)])
                [d networkBridgeDisconnected];
        });
    }

    void onSignalingError(const std::string& error) override {
        NSString* msg = [NSString stringWithUTF8String:error.c_str()];
        dispatch_async(dispatch_get_main_queue(), ^{
            NetworkBridge* b = bridge_;
            if (!b) return;
            id<NetworkBridgeDelegate> d = b.delegate;
            if ([d respondsToSelector:@selector(networkBridgeError:)])
                [d networkBridgeError:msg];
        });
    }

    void onRoomCreated(const std::string& roomId) override {
        NSString* rid = [NSString stringWithUTF8String:roomId.c_str()];
        dispatch_async(dispatch_get_main_queue(), ^{
            NetworkBridge* b = bridge_;
            if (!b) return;
            id<NetworkBridgeDelegate> d = b.delegate;
            if ([d respondsToSelector:@selector(networkBridgeRoomCreated:)])
                [d networkBridgeRoomCreated:rid];
        });
    }

    void onRoomJoined(const std::string& roomId) override {
        NSString* rid = [NSString stringWithUTF8String:roomId.c_str()];
        dispatch_async(dispatch_get_main_queue(), ^{
            NetworkBridge* b = bridge_;
            if (!b) return;
            id<NetworkBridgeDelegate> d = b.delegate;
            if ([d respondsToSelector:@selector(networkBridgeRoomJoined:)])
                [d networkBridgeRoomJoined:rid];
        });
    }

    void onRoomJoinFailed(const std::string& error) override {
        NSString* errMsg = [NSString stringWithUTF8String:error.c_str()];
        dispatch_async(dispatch_get_main_queue(), ^{
            NetworkBridge* b = bridge_;
            if (!b) return;
            id<NetworkBridgeDelegate> d = b.delegate;
            if ([d respondsToSelector:@selector(networkBridgeRoomJoinFailed:)])
                [d networkBridgeRoomJoinFailed:errMsg];
        });
    }

    void onPeerList(const std::string& roomId,
                    const std::vector<S1PeerInfo>& peers) override
    {
        NSMutableArray* arr = [NSMutableArray array];
        for (const auto& p : peers) {
            [arr addObject:@{
                @"user_id": [NSString stringWithUTF8String:p.user_id.c_str()],
                @"ip"     : [NSString stringWithUTF8String:p.ip.c_str()],
                @"port"   : @(p.port)
            }];
        }
        NSString* rid = [NSString stringWithUTF8String:roomId.c_str()];
        dispatch_async(dispatch_get_main_queue(), ^{
            NetworkBridge* b = bridge_;
            if (!b) return;
            id<NetworkBridgeDelegate> d = b.delegate;
            if ([d respondsToSelector:@selector(networkBridgePeerList:roomCode:)])
                [d networkBridgePeerList:[arr copy] roomCode:rid];
        });
    }

    void onPeerJoined(const S1PeerInfo& peer) override {
        NSString* uid = [NSString stringWithUTF8String:peer.user_id.c_str()];
        NSString* ip  = [NSString stringWithUTF8String:peer.ip.c_str()];
        int port = peer.port;
        dispatch_async(dispatch_get_main_queue(), ^{
            NetworkBridge* b = bridge_;
            if (!b) return;
            id<NetworkBridgeDelegate> d = b.delegate;
            if ([d respondsToSelector:@selector(networkBridgePeerJoined:ip:port:)])
                [d networkBridgePeerJoined:uid ip:ip port:port];
        });
    }

    void onPeerLeft(const std::string& userId) override {
        NSString* uid = [NSString stringWithUTF8String:userId.c_str()];
        dispatch_async(dispatch_get_main_queue(), ^{
            NetworkBridge* b = bridge_;
            if (!b) return;
            id<NetworkBridgeDelegate> d = b.delegate;
            if ([d respondsToSelector:@selector(networkBridgePeerLeft:)])
                [d networkBridgePeerLeft:uid];
        });
    }

    void onLatencyMeasured(int ms) override {
        dispatch_async(dispatch_get_main_queue(), ^{
            NetworkBridge* b = bridge_;
            if (!b) return;
            id<NetworkBridgeDelegate> d = b.delegate;
            if ([d respondsToSelector:@selector(networkBridgeLatencyUpdated:)])
                [d networkBridgeLatencyUpdated:ms];
        });
    }

private:
    __weak NetworkBridge* bridge_;
};

// ── NetworkBridge ─────────────────────────────────────────────────────────────

@implementation NetworkBridge {
    std::unique_ptr<S1SignalingClient>        _client;
    std::unique_ptr<SignalingCallbackAdapter> _adapter;
    dispatch_queue_t                          _connectQueue;
}

+ (instancetype)shared {
    static NetworkBridge* inst;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ inst = [[NetworkBridge alloc] init]; });
    return inst;
}

- (instancetype)init {
    if (self = [super init]) {
        _client      = std::make_unique<S1SignalingClient>();
        _adapter     = std::make_unique<SignalingCallbackAdapter>(self);
        _connectQueue = dispatch_queue_create("com.s1.signaling.connect", DISPATCH_QUEUE_SERIAL);
        _client->setCallback(_adapter.get());
    }
    return self;
}

- (void)dealloc {
    _client->disconnect();
}

// ── Connection ────────────────────────────────────────────────────────────────

- (void)connectToHost:(NSString*)host port:(int)port {
    // AppKit client uses WebSocket through nginx proxy.
    // host:port is ignored — always connect to wss://tonel.io/signaling
    dispatch_async(_connectQueue, ^{
        if (!self->_client->isConnected())
            self->_client->connect("api.tonel.io", 443);  // 443 → NSURLSession uses wss://
    });
}

- (void)disconnect {
    _client->disconnect();
}

- (BOOL)isConnected {
    return (BOOL)_client->isConnected();
}

// ── Room actions ──────────────────────────────────────────────────────────────

- (void)createRoom:(NSString*)roomId userId:(NSString*)userId password:(NSString*)password {
    _client->createRoom(roomId.UTF8String, userId.UTF8String, password.UTF8String);
}

- (void)joinRoom:(NSString*)roomId userId:(NSString*)userId password:(NSString*)password {
    _client->joinRoom(roomId.UTF8String, userId.UTF8String, "", 0, password.UTF8String);
}

- (void)leaveRoom:(NSString*)roomId userId:(NSString*)userId {
    _client->leaveRoom(roomId.UTF8String, userId.UTF8String);
}

@end
