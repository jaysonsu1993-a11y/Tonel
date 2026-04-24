// RoomViewController.mm — Active rehearsal room
#import "RoomViewController.h"
#import "S1RoundedButton.h"
#import "S1Theme.h"
#include "../AppState.h"

// ── ParticipantCardView ────────────────────────────────────────────────────

@interface ParticipantCardView : NSView
- (void)updateWithName:(NSString*)name
            instrument:(NSString*)instrument
                volume:(float)volume
                muted:(BOOL)muted
             connected:(BOOL)connected;
@end

@implementation ParticipantCardView {
    NSTextField* _nameLabel;
    NSTextField* _instrLabel;
    NSProgressIndicator* _volumeBar;
    NSTextField* _muteLabel;
}

- (instancetype)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    if (!self) return nil;
    self.wantsLayer = YES;
    self.layer.cornerRadius = 12.0;
    self.layer.backgroundColor = S1ThemeCardBG().CGColor;
    self.layer.borderColor = [NSColor colorWithWhite:1 alpha:0.08].CGColor;
    self.layer.borderWidth = 1.0;
    [self buildSubviews];
    return self;
}

- (void)buildSubviews {
    // Instrument emoji
    _instrLabel = [NSTextField labelWithString:@"🎸"];
    _instrLabel.translatesAutoresizingMaskIntoConstraints = NO;
    _instrLabel.font = [NSFont systemFontOfSize:32];
    [self addSubview:_instrLabel];

    // Name
    _nameLabel = [NSTextField labelWithString:@"—"];
    _nameLabel.translatesAutoresizingMaskIntoConstraints = NO;
    _nameLabel.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
    _nameLabel.textColor = S1ThemeTextPrimary();
    _nameLabel.alignment = NSTextAlignmentCenter;
    [self addSubview:_nameLabel];

    // Mute indicator
    _muteLabel = [NSTextField labelWithString:@""];
    _muteLabel.translatesAutoresizingMaskIntoConstraints = NO;
    _muteLabel.font = [NSFont systemFontOfSize:11];
    _muteLabel.textColor = S1ThemeAccentRed();
    _muteLabel.alignment = NSTextAlignmentCenter;
    [self addSubview:_muteLabel];

    // Volume bar
    _volumeBar = [[NSProgressIndicator alloc] init];
    _volumeBar.translatesAutoresizingMaskIntoConstraints = NO;
    _volumeBar.style = NSProgressIndicatorStyleBar;
    _volumeBar.minValue = 0.0;
    _volumeBar.maxValue = 1.0;
    _volumeBar.doubleValue = 0.8;
    _volumeBar.indeterminate = NO;
    [self addSubview:_volumeBar];

    [NSLayoutConstraint activateConstraints:@[
        [_instrLabel.centerXAnchor constraintEqualToAnchor:self.centerXAnchor],
        [_instrLabel.topAnchor constraintEqualToAnchor:self.topAnchor constant:18],

        [_nameLabel.centerXAnchor constraintEqualToAnchor:self.centerXAnchor],
        [_nameLabel.topAnchor constraintEqualToAnchor:_instrLabel.bottomAnchor constant:8],
        [_nameLabel.leadingAnchor constraintEqualToAnchor:self.leadingAnchor constant:8],
        [_nameLabel.trailingAnchor constraintEqualToAnchor:self.trailingAnchor constant:-8],

        [_muteLabel.centerXAnchor constraintEqualToAnchor:self.centerXAnchor],
        [_muteLabel.topAnchor constraintEqualToAnchor:_nameLabel.bottomAnchor constant:4],

        [_volumeBar.leadingAnchor constraintEqualToAnchor:self.leadingAnchor constant:12],
        [_volumeBar.trailingAnchor constraintEqualToAnchor:self.trailingAnchor constant:-12],
        [_volumeBar.bottomAnchor constraintEqualToAnchor:self.bottomAnchor constant:-14],
        [_volumeBar.heightAnchor constraintEqualToConstant:6],
    ]];
}

- (void)updateWithName:(NSString*)name
            instrument:(NSString*)instrument
                volume:(float)volume
                muted:(BOOL)muted
             connected:(BOOL)connected {
    _nameLabel.stringValue = name;
    _instrLabel.stringValue = instrument.length ? instrument : @"🎸";
    _volumeBar.doubleValue = volume;
    _muteLabel.stringValue = muted ? @"🔇 静音" : @"";
    self.layer.borderColor = connected
        ? [NSColor colorWithWhite:1 alpha:0.08].CGColor
        : [NSColor colorWithWhite:1 alpha:0.03].CGColor;
    self.alphaValue = connected ? 1.0 : 0.5;
}
@end

// ── InputLevelMeter ────────────────────────────────────────────────────────

@interface InputLevelMeter : NSView
@property (nonatomic) float level;  // 0.0–1.0
@end

@implementation InputLevelMeter

- (instancetype)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    if (!self) return nil;
    self.wantsLayer = YES;
    self.layer.backgroundColor = [NSColor colorWithWhite:0.15 alpha:1].CGColor;
    self.layer.cornerRadius = 3.0;
    return self;
}

- (void)setLevel:(float)level {
    _level = level;
    [self setNeedsDisplay:YES];
}

- (void)drawRect:(NSRect)dirtyRect {
    [super drawRect:dirtyRect];

    CGFloat filled = self.bounds.size.width * _level;
    NSRect bar = NSMakeRect(0, 0, filled, self.bounds.size.height);

    // Color: green → yellow → red based on level
    NSColor* color;
    if (_level < 0.6f) {
        color = S1ThemeAccentGreen();
    } else if (_level < 0.85f) {
        color = [NSColor colorWithRed:250/255.0 green:204/255.0 blue:21/255.0 alpha:1];
    } else {
        color = S1ThemeAccentRed();
    }
    [color setFill];
    NSRectFill(bar);
}
@end

// ── RoomViewController ─────────────────────────────────────────────────────

@interface RoomViewController ()
// Status bar
@property (nonatomic, strong) NSTextField*        roomCodeLabel;
@property (nonatomic, strong) NSTextField*        latencyLabel;
@property (nonatomic, strong) NSTextField*        connStateLabel;
// Participant grid
@property (nonatomic, strong) NSStackView*        participantGrid;
@property (nonatomic, strong) NSMutableArray<ParticipantCardView*>* cardViews;
// Controls
@property (nonatomic, strong) S1RoundedButton*    muteButton;
@property (nonatomic, strong) NSSlider*           volumeSlider;
@property (nonatomic, strong) InputLevelMeter*    levelMeter;
@property (nonatomic, strong) NSTextField*        levelLabel;
@property (nonatomic, strong) S1RoundedButton*    leaveButton;
@property (nonatomic, strong) NSButton*           settingsButton;
// Refresh timer (level meter + latency)
@property (nonatomic, strong) NSTimer*            refreshTimer;
@end

@implementation RoomViewController

- (void)loadView {
    self.view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 1024, 768)];
    self.view.wantsLayer = YES;
    self.view.layer.backgroundColor = S1ThemeBG().CGColor;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.cardViews = [NSMutableArray array];
    [self buildUI];
}

- (void)viewDidAppear {
    [super viewDidAppear];
    [self startRefreshTimer];
}

- (void)viewDidDisappear {
    [super viewDidDisappear];
    [self.refreshTimer invalidate];
    self.refreshTimer = nil;
}

// ── UI Build ────────────────────────────────────────────────────────────────

- (void)buildUI {
    NSView* root = self.view;

    // ── Top bar ──────────────────────────────────────────────────────────
    NSView* topBar = [[NSView alloc] init];
    topBar.translatesAutoresizingMaskIntoConstraints = NO;
    topBar.wantsLayer = YES;
    topBar.layer.backgroundColor = [NSColor colorWithWhite:0.1 alpha:1].CGColor;
    [root addSubview:topBar];

    _roomCodeLabel = [self makeLabel:@"Room: —" size:14 weight:NSFontWeightSemibold];
    _latencyLabel  = [self makeLabel:@"— ms"  size:13 weight:NSFontWeightRegular];
    _latencyLabel.textColor = S1ThemeAccentGreen();
    _connStateLabel = [self makeLabel:@"Disconnected" size:13 weight:NSFontWeightRegular];
    _connStateLabel.textColor = S1ThemeTextMuted();

    // Settings button (top-right)
    _settingsButton = [NSButton buttonWithTitle:@"⚙ 设置" target:self action:@selector(openSettings:)];
    _settingsButton.translatesAutoresizingMaskIntoConstraints = NO;
    _settingsButton.font = [NSFont systemFontOfSize:12];
    _settingsButton.contentTintColor = S1ThemeTextMuted();
    _settingsButton.bezelStyle = NSBezelStyleInline;
    _settingsButton.bordered = NO;
    [topBar addSubview:_settingsButton];

    [topBar addSubview:_roomCodeLabel];
    [topBar addSubview:_latencyLabel];
    [topBar addSubview:_connStateLabel];

    // ── Participant grid (scroll view) ───────────────────────────────────
    NSScrollView* scrollView = [[NSScrollView alloc] init];
    scrollView.translatesAutoresizingMaskIntoConstraints = NO;
    scrollView.hasVerticalScroller = YES;
    scrollView.drawsBackground = NO;
    [root addSubview:scrollView];

    _participantGrid = [[NSStackView alloc] init];
    _participantGrid.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    _participantGrid.alignment = NSLayoutAttributeTop;
    _participantGrid.distribution = NSStackViewDistributionFillEqually;
    _participantGrid.spacing = 14;
    _participantGrid.wantsLayer = YES;
    _participantGrid.translatesAutoresizingMaskIntoConstraints = NO;

    NSView* gridWrapper = [[NSView alloc] init];
    gridWrapper.translatesAutoresizingMaskIntoConstraints = NO;
    [gridWrapper addSubview:_participantGrid];
    scrollView.documentView = gridWrapper;

    // ── Bottom controls ──────────────────────────────────────────────────
    NSView* bottomBar = [[NSView alloc] init];
    bottomBar.translatesAutoresizingMaskIntoConstraints = NO;
    bottomBar.wantsLayer = YES;
    bottomBar.layer.backgroundColor = [NSColor colorWithWhite:0.1 alpha:1].CGColor;
    [root addSubview:bottomBar];

    // Mute button
    _muteButton = [[S1RoundedButton alloc] initWithFrame:NSZeroRect];
    _muteButton.title = @"🎙 静音";
    _muteButton.fillColor = [NSColor colorWithWhite:0.2 alpha:1];
    _muteButton.contentTintColor = S1ThemeTextPrimary();
    _muteButton.target = self;
    _muteButton.action = @selector(toggleMute:);
    _muteButton.translatesAutoresizingMaskIntoConstraints = NO;
    [bottomBar addSubview:_muteButton];

    // Volume label + slider
    NSTextField* volLabel = [self makeLabel:@"音量" size:12 weight:NSFontWeightRegular];
    volLabel.textColor = S1ThemeTextMuted();
    [bottomBar addSubview:volLabel];

    _volumeSlider = [NSSlider sliderWithValue:1.0 minValue:0.0 maxValue:1.0
                                       target:self action:@selector(volumeChanged:)];
    _volumeSlider.translatesAutoresizingMaskIntoConstraints = NO;
    [bottomBar addSubview:_volumeSlider];

    // Level meter
    _levelLabel = [self makeLabel:@"输入" size:12 weight:NSFontWeightRegular];
    _levelLabel.textColor = S1ThemeTextMuted();
    [bottomBar addSubview:_levelLabel];

    _levelMeter = [[InputLevelMeter alloc] init];
    _levelMeter.translatesAutoresizingMaskIntoConstraints = NO;
    [bottomBar addSubview:_levelMeter];

    // Leave button
    _leaveButton = [[S1RoundedButton alloc] initWithFrame:NSZeroRect];
    _leaveButton.title = @"离开房间";
    _leaveButton.fillColor = S1ThemeAccentRed();
    _leaveButton.contentTintColor = [NSColor whiteColor];
    _leaveButton.target = self;
    _leaveButton.action = @selector(leaveRoom:);
    _leaveButton.translatesAutoresizingMaskIntoConstraints = NO;
    [bottomBar addSubview:_leaveButton];

    // ── Constraints ──────────────────────────────────────────────────────
    [NSLayoutConstraint activateConstraints:@[
        // Top bar
        [topBar.topAnchor constraintEqualToAnchor:root.topAnchor],
        [topBar.leadingAnchor constraintEqualToAnchor:root.leadingAnchor],
        [topBar.trailingAnchor constraintEqualToAnchor:root.trailingAnchor],
        [topBar.heightAnchor constraintEqualToConstant:48],

        // Top bar contents
        [_roomCodeLabel.leadingAnchor constraintEqualToAnchor:topBar.leadingAnchor constant:20],
        [_roomCodeLabel.centerYAnchor constraintEqualToAnchor:topBar.centerYAnchor],
        [_latencyLabel.leadingAnchor constraintEqualToAnchor:_roomCodeLabel.trailingAnchor constant:20],
        [_latencyLabel.centerYAnchor constraintEqualToAnchor:topBar.centerYAnchor],
        [_settingsButton.trailingAnchor constraintEqualToAnchor:topBar.trailingAnchor constant:-12],
        [_settingsButton.centerYAnchor constraintEqualToAnchor:topBar.centerYAnchor],

        [_connStateLabel.trailingAnchor constraintEqualToAnchor:_settingsButton.leadingAnchor constant:-16],
        [_connStateLabel.centerYAnchor constraintEqualToAnchor:topBar.centerYAnchor],

        // Scroll view
        [scrollView.topAnchor constraintEqualToAnchor:topBar.bottomAnchor constant:16],
        [scrollView.leadingAnchor constraintEqualToAnchor:root.leadingAnchor constant:16],
        [scrollView.trailingAnchor constraintEqualToAnchor:root.trailingAnchor constant:-16],
        [scrollView.bottomAnchor constraintEqualToAnchor:bottomBar.topAnchor constant:-16],

        // Grid wrapper fills scroll view
        [gridWrapper.leadingAnchor constraintEqualToAnchor:scrollView.contentView.leadingAnchor],
        [gridWrapper.topAnchor constraintEqualToAnchor:scrollView.contentView.topAnchor],
        [gridWrapper.widthAnchor constraintEqualToAnchor:scrollView.contentView.widthAnchor],

        [_participantGrid.topAnchor constraintEqualToAnchor:gridWrapper.topAnchor constant:8],
        [_participantGrid.leadingAnchor constraintEqualToAnchor:gridWrapper.leadingAnchor constant:8],
        [_participantGrid.trailingAnchor constraintEqualToAnchor:gridWrapper.trailingAnchor constant:-8],
        [_participantGrid.bottomAnchor constraintEqualToAnchor:gridWrapper.bottomAnchor constant:-8],
        [_participantGrid.heightAnchor constraintGreaterThanOrEqualToConstant:160],

        // Bottom bar
        [bottomBar.bottomAnchor constraintEqualToAnchor:root.bottomAnchor],
        [bottomBar.leadingAnchor constraintEqualToAnchor:root.leadingAnchor],
        [bottomBar.trailingAnchor constraintEqualToAnchor:root.trailingAnchor],
        [bottomBar.heightAnchor constraintEqualToConstant:64],

        // Mute button
        [_muteButton.leadingAnchor constraintEqualToAnchor:bottomBar.leadingAnchor constant:20],
        [_muteButton.centerYAnchor constraintEqualToAnchor:bottomBar.centerYAnchor],
        [_muteButton.widthAnchor constraintEqualToConstant:90],
        [_muteButton.heightAnchor constraintEqualToConstant:36],

        // Volume
        [volLabel.leadingAnchor constraintEqualToAnchor:_muteButton.trailingAnchor constant:20],
        [volLabel.centerYAnchor constraintEqualToAnchor:bottomBar.centerYAnchor],
        [_volumeSlider.leadingAnchor constraintEqualToAnchor:volLabel.trailingAnchor constant:8],
        [_volumeSlider.centerYAnchor constraintEqualToAnchor:bottomBar.centerYAnchor],
        [_volumeSlider.widthAnchor constraintEqualToConstant:140],

        // Level meter
        [_levelLabel.leadingAnchor constraintEqualToAnchor:_volumeSlider.trailingAnchor constant:24],
        [_levelLabel.centerYAnchor constraintEqualToAnchor:bottomBar.centerYAnchor],
        [_levelMeter.leadingAnchor constraintEqualToAnchor:_levelLabel.trailingAnchor constant:8],
        [_levelMeter.centerYAnchor constraintEqualToAnchor:bottomBar.centerYAnchor],
        [_levelMeter.widthAnchor constraintEqualToConstant:180],
        [_levelMeter.heightAnchor constraintEqualToConstant:12],

        // Leave button
        [_leaveButton.trailingAnchor constraintEqualToAnchor:bottomBar.trailingAnchor constant:-20],
        [_leaveButton.centerYAnchor constraintEqualToAnchor:bottomBar.centerYAnchor],
        [_leaveButton.widthAnchor constraintEqualToConstant:96],
        [_leaveButton.heightAnchor constraintEqualToConstant:36],
    ]];
}

// ── Helpers ────────────────────────────────────────────────────────────────

- (NSTextField*)makeLabel:(NSString*)text size:(CGFloat)size weight:(NSFontWeight)weight {
    NSTextField* lbl = [NSTextField labelWithString:text];
    lbl.translatesAutoresizingMaskIntoConstraints = NO;
    lbl.font = [NSFont systemFontOfSize:size weight:weight];
    lbl.textColor = S1ThemeTextPrimary();
    return lbl;
}

- (void)setButtonTextColor:(NSButton*)btn color:(NSColor*)color {
    NSMutableAttributedString* attr = [[NSMutableAttributedString alloc]
        initWithString:btn.title];
    [attr addAttribute:NSForegroundColorAttributeName
                 value:color
                 range:NSMakeRange(0, btn.title.length)];
    btn.attributedTitle = attr;
}

// ── Refresh ────────────────────────────────────────────────────────────────

- (void)refresh {
    AppState& state = AppState::shared();

    // Status bar
    _roomCodeLabel.stringValue = [NSString stringWithFormat:@"Room: %s",
                                   state.getRoomCode().c_str()];
    _latencyLabel.stringValue = [NSString stringWithFormat:@"%d ms",
                                  state.getEstimatedLatencyMs()];

    switch (state.getConnectionState()) {
        case AppState::ConnectionState::Connected:
            _connStateLabel.stringValue = @"● 已连接";
            _connStateLabel.textColor = S1ThemeAccentGreen();
            break;
        case AppState::ConnectionState::Connecting:
            _connStateLabel.stringValue = @"● 连接中…";
            _connStateLabel.textColor = [NSColor colorWithRed:250/255.0 green:204/255.0 blue:21/255.0 alpha:1];
            break;
        case AppState::ConnectionState::Error:
            _connStateLabel.stringValue = @"● 错误";
            _connStateLabel.textColor = S1ThemeAccentRed();
            break;
        default:
            _connStateLabel.stringValue = @"● 未连接";
            _connStateLabel.textColor = S1ThemeTextMuted();
    }

    // Rebuild participant cards
    for (NSView* v in _participantGrid.arrangedSubviews.copy) {
        [_participantGrid removeArrangedSubview:v];
        [v removeFromSuperview];
    }
    [_cardViews removeAllObjects];

    const auto& participants = state.getParticipants();
    for (const auto& p : participants) {
        ParticipantCardView* card = [[ParticipantCardView alloc]
            initWithFrame:NSMakeRect(0, 0, 160, 160)];
        [card updateWithName:[NSString stringWithUTF8String:p.name.c_str()]
                  instrument:[NSString stringWithUTF8String:p.instrument.c_str()]
                      volume:p.volume
                       muted:p.isMuted
                   connected:p.isConnected];
        [card setTranslatesAutoresizingMaskIntoConstraints:NO];
        [card addConstraint:[NSLayoutConstraint constraintWithItem:card
            attribute:NSLayoutAttributeHeight relatedBy:NSLayoutRelationEqual
            toItem:nil attribute:NSLayoutAttributeNotAnAttribute multiplier:1 constant:160]];
        [_participantGrid addArrangedSubview:card];
        [_cardViews addObject:card];
    }

    // Local controls
    _volumeSlider.doubleValue = state.getMyVolume();
    [self updateMuteButtonAppearance:state.isMyMuted()];
}

- (void)startRefreshTimer {
    [self.refreshTimer invalidate];
    self.refreshTimer = [NSTimer scheduledTimerWithTimeInterval:0.05
                                                         target:self
                                                       selector:@selector(timerTick:)
                                                       userInfo:nil
                                                        repeats:YES];
}

- (void)timerTick:(NSTimer*)timer {
    // Update only the level meter at 20 Hz to avoid full UI refresh overhead
    float level = AppState::shared().getInputLevel();
    _levelMeter.level = level;
}

- (void)updateMuteButtonAppearance:(BOOL)muted {
    NSString* title = muted ? @"🔇 已静音" : @"🎙 静音";
    NSColor* bg = muted ? S1ThemeAccentRed() : [NSColor colorWithWhite:0.2 alpha:1];
    _muteButton.fillColor = bg;
    _muteButton.contentTintColor = [NSColor whiteColor];
    _muteButton.title = title;
    [_muteButton setNeedsDisplay:YES];
}

// ── Actions ────────────────────────────────────────────────────────────────

- (void)toggleMute:(id)sender {
    AppState& state = AppState::shared();
    bool newMuted = !state.isMyMuted();
    state.setMyMuted(newMuted);
    [self updateMuteButtonAppearance:newMuted];
}

- (void)volumeChanged:(id)sender {
    AppState::shared().setMyVolume(_volumeSlider.floatValue);
}

- (void)leaveRoom:(id)sender {
    [self.refreshTimer invalidate];
    self.refreshTimer = nil;
    if (self.onLeaveRoom) self.onLeaveRoom();
}

- (void)openSettings:(id)sender {
    if (self.onOpenSettings) self.onOpenSettings();
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

- (void)cleanup {
    [self.refreshTimer invalidate];
    self.refreshTimer = nil;
}

@end
