// MainWindowController.mm — Root window controller; manages view transitions
#import "MainWindowController.h"
#import "AppState.h"
#import "ui/S1Theme.h"
#import "bridge/NetworkBridge.h"
#import "bridge/AudioBridge.h"
#import "bridge/MixerBridge.h"
#import "ui/HomeViewController.h"
#import "ui/CreateRoomViewController.h"
#import "ui/JoinRoomViewController.h"
#import "ui/RoomViewController.h"
#import "ui/SettingsViewController.h"

static const CGFloat kWindowWidth  = S1ThemeWindowWidth;
static const CGFloat kWindowHeight = S1ThemeWindowHeight;

typedef NS_ENUM(NSInteger, PendingRoomAction) {
    PendingRoomActionNone = 0,
    PendingRoomActionCreate,
    PendingRoomActionJoin,
};

@interface MainWindowController () <NetworkBridgeDelegate>
@property (nonatomic, strong, readwrite) HomeViewController*         homeVC;
@property (nonatomic, strong, readwrite) CreateRoomViewController*   createRoomVC;
@property (nonatomic, strong, readwrite) JoinRoomViewController*     joinRoomVC;
@property (nonatomic, strong, readwrite) RoomViewController*         roomVC;
@property (nonatomic, strong, readwrite) SettingsViewController*     settingsVC;
/// Tracks where we came from when opening Settings (home vs. room)
@property (nonatomic, assign) BOOL settingsFromRoom;
/// Pending room action to execute once signaling is connected
@property (nonatomic, assign) PendingRoomAction pendingAction;
@property (nonatomic, copy)   NSString* pendingRoomCode;
@property (nonatomic, copy)   NSString* pendingPassword;
@property (nonatomic, copy)   NSString* pendingUserId;
@end

@implementation MainWindowController

- (instancetype)init {
    NSWindow* window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, kWindowWidth, kWindowHeight)
                  styleMask:(NSWindowStyleMaskTitled |
                             NSWindowStyleMaskClosable |
                             NSWindowStyleMaskMiniaturizable |
                             NSWindowStyleMaskResizable)
                    backing:NSBackingStoreBuffered
                      defer:NO];
    window.title = @"Tonel";
    window.minSize = NSMakeSize(S1ThemeMinWidth, S1ThemeMinHeight);
    [window center];

    if (self = [super initWithWindow:window]) {
        [self setupViewControllers];
        [self showHome];
    }
    return self;
}

- (void)setupViewControllers {
    __weak typeof(self) weakSelf = self;

    // ── Home ──────────────────────────────────────────────────────────────
    self.homeVC = [[HomeViewController alloc] init];
    self.homeVC.onCreateRoom = ^{ [weakSelf showCreateRoom]; };
    self.homeVC.onJoinRoom   = ^{ [weakSelf showJoinRoom]; };
    self.homeVC.onSettings   = ^{ weakSelf.settingsFromRoom = NO; [weakSelf showSettings]; };

    // ── Create Room ───────────────────────────────────────────────────────
    self.createRoomVC = [[CreateRoomViewController alloc] init];
    self.createRoomVC.onConfirm = ^(NSString* code, NSString* password) {
        [weakSelf handleCreateRoomWithCode:code password:password];
    };
    self.createRoomVC.onCancel = ^{ [weakSelf showHome]; };

    // ── Join Room ─────────────────────────────────────────────────────────
    self.joinRoomVC = [[JoinRoomViewController alloc] init];
    self.joinRoomVC.onConfirm = ^(NSString* code, NSString* password) {
        [weakSelf handleJoinRoomWithCode:code password:password];
    };
    self.joinRoomVC.onCancel = ^{ [weakSelf showHome]; };

    // ── Room ──────────────────────────────────────────────────────────────
    self.roomVC = [[RoomViewController alloc] init];
    self.roomVC.onLeaveRoom = ^{ [weakSelf handleLeaveRoom]; };
    self.roomVC.onOpenSettings = ^{
        weakSelf.settingsFromRoom = YES;
        [weakSelf showSettings];
    };

    // ── Settings ──────────────────────────────────────────────────────────
    self.settingsVC = [[SettingsViewController alloc] init];
    self.settingsVC.onClose = ^{
        if (weakSelf.settingsFromRoom)
            [weakSelf showRoomReload:NO];
        else
            [weakSelf showHome];
    };

    // ── Network Bridge delegate ────────────────────────────────────────────
    [NetworkBridge shared].delegate = weakSelf;
}

// ── Navigation ─────────────────────────────────────────────────────────────

- (void)showHome {
    self.window.contentViewController = self.homeVC;
}

- (void)showCreateRoom {
    self.window.contentViewController = self.createRoomVC;
}

- (void)showJoinRoom {
    self.window.contentViewController = self.joinRoomVC;
}

- (void)showRoom {
    [self showRoomReload:YES];
}

- (void)showRoomReload:(BOOL)reload {
    [[AudioBridge shared] start];
    if (reload) [self.roomVC refresh];
    self.window.contentViewController = self.roomVC;
}

- (void)showSettings {
    self.window.contentViewController = self.settingsVC;
}

// ── Handlers ───────────────────────────────────────────────────────────────

- (void)handleCreateRoomWithCode:(NSString*)code password:(NSString*)password {
    NSLog(@"[App] Creating room: %@%@", code, password.length > 0 ? @" (password protected)" : @"");
    AppState& state = AppState::shared();
    state.setRoomCode(code.UTF8String);
    state.setConnectionState(AppState::ConnectionState::Connecting);

    NSString* userId = [self generateUserId];
    state.setRoomOwner(userId.UTF8String);

    NetworkBridge* bridge = [NetworkBridge shared];
    if ([bridge isConnected]) {
        [bridge createRoom:code userId:userId password:password];
    } else {
        self.pendingAction   = PendingRoomActionCreate;
        self.pendingRoomCode = code;
        self.pendingPassword = password;
        self.pendingUserId   = userId;
        [bridge connectToHost:@"tonel.io" port:9001];
    }
}

- (void)handleJoinRoomWithCode:(NSString*)code password:(NSString*)password {
    NSLog(@"[App] Joining room: %@%@", code, password.length > 0 ? @" (with password)" : @"");
    AppState& state = AppState::shared();
    state.setRoomCode(code.UTF8String);
    state.setConnectionState(AppState::ConnectionState::Connecting);

    NSString* userId = [self generateUserId];
    state.setRoomOwner(userId.UTF8String);

    NetworkBridge* bridge = [NetworkBridge shared];
    if ([bridge isConnected]) {
        [bridge joinRoom:code userId:userId password:password];
    } else {
        self.pendingAction   = PendingRoomActionJoin;
        self.pendingRoomCode = code;
        self.pendingPassword = password;
        self.pendingUserId   = userId;
        [bridge connectToHost:@"tonel.io" port:9001];
    }
}

- (void)handleLeaveRoom {
    // Disconnect mixer first, then stop audio
    [self disconnectMixer];
    [[AudioBridge shared] stop];
    // Send leave_room to server before clearing state
    AppState& state = AppState::shared();
    std::string roomCode = state.getRoomCode();
    std::string userId = state.getRoomOwner();
    if (!roomCode.empty() && !userId.empty()) {
        NSString* rId = [NSString stringWithUTF8String:roomCode.c_str()];
        NSString* uId = [NSString stringWithUTF8String:userId.c_str()];
        [[NetworkBridge shared] leaveRoom:rId userId:uId];
    }
    state.clearParticipants();
    state.setConnectionState(AppState::ConnectionState::Disconnected);
    state.setRoomCode("");
    [self showHome];
}

- (void)cleanup {
    [self.roomVC cleanup];
}

// ── NetworkBridgeDelegate ──────────────────────────────────────────────────

- (void)networkBridgeConnected {
    NSLog(@"[App] Signaling connected");
    AppState::shared().setConnectionState(AppState::ConnectionState::Connected);

    if (self.pendingAction == PendingRoomActionCreate) {
        [[NetworkBridge shared] createRoom:self.pendingRoomCode
                                    userId:self.pendingUserId
                                  password:self.pendingPassword];
    } else if (self.pendingAction == PendingRoomActionJoin) {
        [[NetworkBridge shared] joinRoom:self.pendingRoomCode
                                  userId:self.pendingUserId
                                password:self.pendingPassword];
    }
    self.pendingAction = PendingRoomActionNone;
}

- (void)networkBridgeDisconnected {
    NSLog(@"[App] Signaling disconnected");
    AppState::shared().setConnectionState(AppState::ConnectionState::Disconnected);

    if (self.pendingAction != PendingRoomActionNone) {
        self.pendingAction = PendingRoomActionNone;
        dispatch_async(dispatch_get_main_queue(), ^{
            NSAlert* alert = [[NSAlert alloc] init];
            alert.messageText = @"连接失败";
            alert.informativeText = @"无法连接到服务器，请检查网络后重试。";
            [alert addButtonWithTitle:@"确定"];
            [alert runModal];
            [self showHome];
        });
        return;
    }

    // If in room, kick back to home
    if (!AppState::shared().getRoomCode().empty()) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self handleLeaveRoom];
        });
    }
}

- (void)networkBridgeError:(NSString*)error {
    NSLog(@"[App] Signaling error: %@", error);
    AppState::shared().setConnectionState(AppState::ConnectionState::Error);

    if (self.pendingAction != PendingRoomActionNone) {
        self.pendingAction = PendingRoomActionNone;
        dispatch_async(dispatch_get_main_queue(), ^{
            NSAlert* alert = [[NSAlert alloc] init];
            alert.messageText = @"连接失败";
            alert.informativeText = [NSString stringWithFormat:@"服务器错误: %@", error];
            [alert addButtonWithTitle:@"确定"];
            [alert runModal];
            [self showHome];
        });
    }
}

- (void)networkBridgeLatencyUpdated:(int)ms {
    AppState::shared().setLatency(ms);
}

- (void)networkBridgeRoomCreated:(NSString*)roomCode {
    NSLog(@"[App] Room created: %@", roomCode);
    AppState::shared().setConnectionState(AppState::ConnectionState::Connected);
    // Add self as participant
    AppState::shared().clearParticipants();
    AppState::shared().addParticipant({0, AppState::shared().getRoomOwner(), "🎸", 1.0f, false, true});
    // Connect to mixer server for audio transport
    [self connectMixer];
    dispatch_async(dispatch_get_main_queue(), ^{
        [self showRoomReload:YES];
    });
}

- (void)networkBridgeRoomJoined:(NSString*)roomCode {
    NSLog(@"[App] Joined room: %@", roomCode);
    AppState::shared().setConnectionState(AppState::ConnectionState::Connected);
    // Add self as participant; peers will arrive via peer_list / peer_joined
    AppState::shared().clearParticipants();
    AppState::shared().addParticipant({0, AppState::shared().getRoomOwner(), "🎸", 1.0f, false, true});
    // Connect to mixer server for audio transport
    [self connectMixer];
    dispatch_async(dispatch_get_main_queue(), ^{
        [self showRoomReload:YES];
    });
}

- (void)networkBridgeRoomJoinFailed:(NSString*)errorMessage {
    NSLog(@"[App] Join failed: %@", errorMessage);
    AppState::shared().setConnectionState(AppState::ConnectionState::Error);
    dispatch_async(dispatch_get_main_queue(), ^{
        NSAlert* alert = [[NSAlert alloc] init];
        alert.messageText = @"加入房间失败";
        alert.informativeText = [NSString stringWithFormat:@"服务器返回: %@", errorMessage];
        [alert addButtonWithTitle:@"确定"];
        [alert runModal];
        [self showHome];
    });
}

- (void)networkBridgePeerJoined:(NSString*)userId ip:(NSString*)ip port:(int)port {
    NSLog(@"[App] Peer joined: %@", userId);
    dispatch_async(dispatch_get_main_queue(), ^{
        AppState::shared().addParticipant({0, userId.UTF8String, "🎸", 1.0f, false, true});
        [self.roomVC refresh];
    });
}

- (void)networkBridgePeerLeft:(NSString*)userId {
    NSLog(@"[App] Peer left: %@", userId);
    // Find and remove participant by userId
    std::string uid = userId.UTF8String;
    for (const auto& p : AppState::shared().getParticipants()) {
        if (p.name == uid) {
            AppState::shared().removeParticipant(p.id);
            break;
        }
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        [self.roomVC refresh];
    });
}

- (void)networkBridgePeerList:(NSArray<NSDictionary*>*)peers roomCode:(NSString*)roomCode {
    NSLog(@"[App] Peer list received: %lu peers", (unsigned long)peers.count);
    dispatch_async(dispatch_get_main_queue(), ^{
        AppState& state = AppState::shared();
        for (NSDictionary* p in peers) {
            std::string peerUserId = ((NSString*)p[@"user_id"]).UTF8String;
            // Skip if already in list
            bool exists = false;
            for (const auto& existing : state.getParticipants()) {
                if (existing.name == peerUserId) { exists = true; break; }
            }
            if (!exists) {
                state.addParticipant({0, peerUserId, "🎸", 1.0f, false, true});
            }
        }
        [self.roomVC refresh];
    });
}

// ── Mixer connection ───────────────────────────────────────────────────────

- (void)connectMixer {
    NSString* roomCode = [NSString stringWithUTF8String:AppState::shared().getRoomCode().c_str()];
    NSString* userId   = [NSString stringWithUTF8String:AppState::shared().getRoomOwner().c_str()];

    // Wire MixerBridge into AudioBridge so the audio thread can send/receive
    [[AudioBridge shared] setMixerBridge:[MixerBridge shared]];
    [[MixerBridge shared] connectToRoom:roomCode userId:userId];
    NSLog(@"[App] Connecting to mixer: room=%@ user=%@", roomCode, userId);
}

- (void)disconnectMixer {
    [[AudioBridge shared] setMixerBridge:nil];
    [[MixerBridge shared] disconnect];
    NSLog(@"[App] Disconnected from mixer");
}

// ── Helpers ────────────────────────────────────────────────────────────────

- (NSString*)generateUserId {
    UInt64 ts = (UInt64)[[NSDate date] timeIntervalSince1970] * 1000;
    UInt32 rand = arc4random_uniform(65536);
    return [NSString stringWithFormat:@"user_%08llx_%04x", ts, rand];
}

@end
