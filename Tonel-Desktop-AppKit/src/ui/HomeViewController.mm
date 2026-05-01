// HomeViewController.mm — Home screen (create / join room)
#import "HomeViewController.h"
#import "S1RoundedButton.h"
#import "S1Theme.h"

@interface HomeViewController ()
@property (nonatomic, strong) NSTextField*     titleLabel;
@property (nonatomic, strong) NSTextField*     subtitleLabel;
@property (nonatomic, strong) S1RoundedButton* createRoomBtn;
@property (nonatomic, strong) S1RoundedButton* joinRoomBtn;
@property (nonatomic, strong) NSButton*        settingsBtn;
@end

@implementation HomeViewController

- (void)loadView {
    self.view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 1024, 768)];
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.wantsLayer = YES;
    self.view.layer.backgroundColor = S1ThemeBG().CGColor;
    [self buildUI];
}

- (void)buildUI {
    // Title
    self.titleLabel = [NSTextField labelWithString:@"Tonel"];
    self.titleLabel.font = [NSFont systemFontOfSize:56.0 weight:NSFontWeightBold];
    self.titleLabel.textColor = [NSColor whiteColor];
    self.titleLabel.alignment = NSTextAlignmentCenter;
    self.titleLabel.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.titleLabel];

    // Subtitle
    self.subtitleLabel = [NSTextField labelWithString:@"实时乐队排练平台"];
    self.subtitleLabel.font = [NSFont systemFontOfSize:18.0 weight:NSFontWeightLight];
    self.subtitleLabel.textColor = [NSColor colorWithWhite:0.6 alpha:1.0];
    self.subtitleLabel.alignment = NSTextAlignmentCenter;
    self.subtitleLabel.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.subtitleLabel];

    // Create Room button
    self.createRoomBtn = [[S1RoundedButton alloc] initWithFrame:NSZeroRect];
    self.createRoomBtn.title = @"创建房间";
    self.createRoomBtn.fillColor = [NSColor colorWithRed:0.18 green:0.18 blue:0.22 alpha:1.0];
    self.createRoomBtn.contentTintColor = S1ThemeTextPrimary();
    self.createRoomBtn.font = [NSFont systemFontOfSize:16.0 weight:NSFontWeightMedium];
    self.createRoomBtn.translatesAutoresizingMaskIntoConstraints = NO;
    self.createRoomBtn.target = self;
    self.createRoomBtn.action = @selector(createRoomTapped);
    [self.view addSubview:self.createRoomBtn];

    // Join Room button
    self.joinRoomBtn = [[S1RoundedButton alloc] initWithFrame:NSZeroRect];
    self.joinRoomBtn.title = @"加入房间";
    self.joinRoomBtn.fillColor = [NSColor colorWithRed:0.12 green:0.28 blue:0.55 alpha:1.0];
    self.joinRoomBtn.contentTintColor = S1ThemeTextPrimary();
    self.joinRoomBtn.font = [NSFont systemFontOfSize:16.0 weight:NSFontWeightMedium];
    self.joinRoomBtn.translatesAutoresizingMaskIntoConstraints = NO;
    self.joinRoomBtn.target = self;
    self.joinRoomBtn.action = @selector(joinRoomTapped);
    [self.view addSubview:self.joinRoomBtn];

    // Settings button
    self.settingsBtn = [NSButton buttonWithTitle:@"⚙ 设置" target:self action:@selector(settingsTapped)];
    self.settingsBtn.font = [NSFont systemFontOfSize:13.0];
    self.settingsBtn.contentTintColor = [NSColor colorWithWhite:0.5 alpha:1.0];
    self.settingsBtn.bezelStyle = NSBezelStyleInline;
    self.settingsBtn.bordered = NO;
    self.settingsBtn.translatesAutoresizingMaskIntoConstraints = NO;
    [self.view addSubview:self.settingsBtn];

    // Layout
    [NSLayoutConstraint activateConstraints:@[
        // Title centered horizontally, 60% up from bottom
        [self.titleLabel.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [self.titleLabel.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor constant:-80],

        // Subtitle below title
        [self.subtitleLabel.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [self.subtitleLabel.topAnchor constraintEqualToAnchor:self.titleLabel.bottomAnchor constant:12],

        // Create Room button
        [self.createRoomBtn.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [self.createRoomBtn.topAnchor constraintEqualToAnchor:self.subtitleLabel.bottomAnchor constant:48],
        [self.createRoomBtn.widthAnchor constraintEqualToConstant:240],
        [self.createRoomBtn.heightAnchor constraintEqualToConstant:52],

        // Join Room button
        [self.joinRoomBtn.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [self.joinRoomBtn.topAnchor constraintEqualToAnchor:self.createRoomBtn.bottomAnchor constant:16],
        [self.joinRoomBtn.widthAnchor constraintEqualToConstant:240],
        [self.joinRoomBtn.heightAnchor constraintEqualToConstant:52],

        // Settings button at bottom
        [self.settingsBtn.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
        [self.settingsBtn.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor constant:-24],
    ]];
}

- (void)createRoomTapped { if (self.onCreateRoom) self.onCreateRoom(); }
- (void)joinRoomTapped   { if (self.onJoinRoom)   self.onJoinRoom();   }
- (void)settingsTapped   { if (self.onSettings)   self.onSettings();   }

@end
