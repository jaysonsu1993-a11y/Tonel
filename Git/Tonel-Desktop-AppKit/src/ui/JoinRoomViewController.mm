// JoinRoomViewController.mm — Join room dialog
#import "JoinRoomViewController.h"
#import "S1RoundedButton.h"
#import "S1Theme.h"


@interface JoinRoomViewController ()
@property (nonatomic, strong) NSTextField* roomCodeField;
@property (nonatomic, strong) NSSecureTextField* passwordField;
@end

@implementation JoinRoomViewController

- (void)loadView {
    self.view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 1024, 768)];
    self.view.wantsLayer = YES;
    self.view.layer.backgroundColor = S1ThemeBG().CGColor;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    [self buildUI];
}

- (void)buildUI {
    NSView* root = self.view;

    // Card
    NSView* card = [[NSView alloc] init];
    card.translatesAutoresizingMaskIntoConstraints = NO;
    card.wantsLayer = YES;
    card.layer.backgroundColor = CardS1ThemeBG().CGColor;
    card.layer.cornerRadius = 14.0;
    card.layer.borderColor = [NSColor colorWithWhite:1 alpha:0.08].CGColor;
    card.layer.borderWidth = 1.0;
    [root addSubview:card];

    // Title
    NSTextField* title = [NSTextField labelWithString:@"加入房间"];
    title.translatesAutoresizingMaskIntoConstraints = NO;
    title.font = [NSFont systemFontOfSize:22 weight:NSFontWeightBold];
    title.textColor = S1ThemeTextPrimary();
    [card addSubview:title];

    // Room code label + field
    NSTextField* codeLabel = [self rowLabel:@"房间号"];
    [card addSubview:codeLabel];

    _roomCodeField = [[NSTextField alloc] init];
    _roomCodeField.translatesAutoresizingMaskIntoConstraints = NO;
    _roomCodeField.placeholderString = @"输入房间号";
    _roomCodeField.font = [NSFont systemFontOfSize:14];
    _roomCodeField.textColor = S1ThemeTextPrimary();
    _roomCodeField.backgroundColor = FieldS1ThemeBG();
    _roomCodeField.wantsLayer = YES;
    _roomCodeField.layer.cornerRadius = 8;
    _roomCodeField.bezeled = NO;
    _roomCodeField.drawsBackground = YES;
    [card addSubview:_roomCodeField];

    // Password label + field
    NSTextField* pwLabel = [self rowLabel:@"房间密码"];
    [card addSubview:pwLabel];

    _passwordField = [[NSSecureTextField alloc] init];
    _passwordField.translatesAutoresizingMaskIntoConstraints = NO;
    _passwordField.placeholderString = @"无密码则留空";
    _passwordField.font = [NSFont systemFontOfSize:14];
    _passwordField.textColor = S1ThemeTextPrimary();
    _passwordField.backgroundColor = FieldS1ThemeBG();
    _passwordField.wantsLayer = YES;
    _passwordField.layer.cornerRadius = 8;
    _passwordField.bezeled = NO;
    _passwordField.drawsBackground = YES;
    [card addSubview:_passwordField];

    // Confirm button
    S1RoundedButton* confirmBtn = [[S1RoundedButton alloc] initWithFrame:NSZeroRect];
    confirmBtn.title = @"加入";
    confirmBtn.fillColor = S1ThemeAccentGreen();
    confirmBtn.contentTintColor = [NSColor colorWithRed:10/255.0 green:30/255.0 blue:20/255.0 alpha:1];
    confirmBtn.font = [NSFont systemFontOfSize:15 weight:NSFontWeightMedium];
    confirmBtn.translatesAutoresizingMaskIntoConstraints = NO;
    confirmBtn.target = self;
    confirmBtn.action = @selector(confirmTapped:);
    [card addSubview:confirmBtn];

    // Cancel button
    S1RoundedButton* cancelBtn = [[S1RoundedButton alloc] initWithFrame:NSZeroRect];
    cancelBtn.title = @"取消";
    cancelBtn.fillColor = [NSColor colorWithWhite:0.2 alpha:1];
    cancelBtn.contentTintColor = S1ThemeTextMuted();
    cancelBtn.font = [NSFont systemFontOfSize:15 weight:NSFontWeightRegular];
    cancelBtn.translatesAutoresizingMaskIntoConstraints = NO;
    cancelBtn.target = self;
    cancelBtn.action = @selector(cancelTapped:);
    [card addSubview:cancelBtn];

    // ── Constraints ──────────────────────────────────────────────────────
    CGFloat cardW = 440, pad = 28, rowH = 40, labelW = 100, fieldH = 36;

    [NSLayoutConstraint activateConstraints:@[
        // Card centered
        [card.centerXAnchor constraintEqualToAnchor:root.centerXAnchor],
        [card.centerYAnchor constraintEqualToAnchor:root.centerYAnchor],
        [card.widthAnchor constraintEqualToConstant:cardW],

        // Title
        [title.topAnchor constraintEqualToAnchor:card.topAnchor constant:pad],
        [title.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:pad],

        // Room code row
        [codeLabel.topAnchor constraintEqualToAnchor:title.bottomAnchor constant:28],
        [codeLabel.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:pad],
        [codeLabel.widthAnchor constraintEqualToConstant:labelW],
        [codeLabel.heightAnchor constraintEqualToConstant:rowH],
        [_roomCodeField.centerYAnchor constraintEqualToAnchor:codeLabel.centerYAnchor],
        [_roomCodeField.leadingAnchor constraintEqualToAnchor:codeLabel.trailingAnchor constant:12],
        [_roomCodeField.trailingAnchor constraintEqualToAnchor:card.trailingAnchor constant:-pad],
        [_roomCodeField.heightAnchor constraintEqualToConstant:fieldH],

        // Password row
        [pwLabel.topAnchor constraintEqualToAnchor:codeLabel.bottomAnchor constant:16],
        [pwLabel.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:pad],
        [pwLabel.widthAnchor constraintEqualToConstant:labelW],
        [pwLabel.heightAnchor constraintEqualToConstant:rowH],
        [_passwordField.centerYAnchor constraintEqualToAnchor:pwLabel.centerYAnchor],
        [_passwordField.leadingAnchor constraintEqualToAnchor:pwLabel.trailingAnchor constant:12],
        [_passwordField.trailingAnchor constraintEqualToAnchor:card.trailingAnchor constant:-pad],
        [_passwordField.heightAnchor constraintEqualToConstant:fieldH],

        // Buttons
        [cancelBtn.topAnchor constraintEqualToAnchor:pwLabel.bottomAnchor constant:28],
        [cancelBtn.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:pad],
        [cancelBtn.widthAnchor constraintEqualToConstant:120],
        [cancelBtn.heightAnchor constraintEqualToConstant:40],

        [confirmBtn.topAnchor constraintEqualToAnchor:cancelBtn.topAnchor],
        [confirmBtn.trailingAnchor constraintEqualToAnchor:card.trailingAnchor constant:-pad],
        [confirmBtn.widthAnchor constraintEqualToConstant:120],
        [confirmBtn.heightAnchor constraintEqualToConstant:40],

        // Card bottom
        [card.bottomAnchor constraintEqualToAnchor:cancelBtn.bottomAnchor constant:pad],
    ]];
}

- (NSTextField*)rowLabel:(NSString*)text {
    NSTextField* lbl = [NSTextField labelWithString:text];
    lbl.translatesAutoresizingMaskIntoConstraints = NO;
    lbl.font = [NSFont systemFontOfSize:13 weight:NSFontWeightRegular];
    lbl.textColor = [NSColor colorWithWhite:0.75 alpha:1];
    return lbl;
}

- (void)confirmTapped:(id)sender {
    NSString* code = [_roomCodeField.stringValue stringByTrimmingCharactersInSet:
                      NSCharacterSet.whitespaceCharacterSet];
    if (code.length == 0) {
        // Show alert if no room code entered
        NSAlert* alert = [[NSAlert alloc] init];
        alert.messageText = @"请输入房间号";
        alert.informativeText = @"房间号不能为空。";
        [alert addButtonWithTitle:@"好的"];
        [alert runModal];
        return;
    }
    if (self.onConfirm) self.onConfirm([code uppercaseString], _passwordField.stringValue);
}

- (void)cancelTapped:(id)sender {
    if (self.onCancel) self.onCancel();
}

@end
