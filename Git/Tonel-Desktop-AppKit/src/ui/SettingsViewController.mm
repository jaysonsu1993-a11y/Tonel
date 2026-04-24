// SettingsViewController.mm — Settings: CoreAudio device pickers + buffer/sample rate
#import "SettingsViewController.h"
#import "S1Theme.h"
#import <CoreAudio/CoreAudio.h>
#import <AudioToolbox/AudioToolbox.h>

// ── CoreAudio device enumeration ───────────────────────────────────────────

static NSArray<NSString*>* EnumerateAudioDevices(Boolean inputOnly) {
    NSMutableArray<NSString*>* names = [NSMutableArray array];

    AudioObjectPropertyAddress propAddr = {
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };

    UInt32 dataSize = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject,
                                                     &propAddr, 0, NULL, &dataSize);
    if (status != noErr || dataSize == 0) return names;

    NSUInteger count = dataSize / sizeof(AudioDeviceID);
    AudioDeviceID* deviceIDs = (AudioDeviceID*)malloc(dataSize);
    if (!deviceIDs) return names;

    status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &propAddr,
                                        0, NULL, &dataSize, deviceIDs);
    if (status != noErr) {
        free(deviceIDs);
        return names;
    }

    AudioObjectPropertyScope scope = inputOnly
        ? kAudioDevicePropertyScopeInput
        : kAudioDevicePropertyScopeOutput;

    for (NSUInteger i = 0; i < count; i++) {
        AudioDeviceID devID = deviceIDs[i];

        // Check that the device has streams in the requested direction
        AudioObjectPropertyAddress streamsAddr = {
            kAudioDevicePropertyStreams, scope, kAudioObjectPropertyElementMain
        };
        UInt32 streamsSize = 0;
        AudioObjectGetPropertyDataSize(devID, &streamsAddr, 0, NULL, &streamsSize);
        if (streamsSize == 0) continue;

        // Get device name
        CFStringRef nameRef = NULL;
        UInt32 nameSize = sizeof(nameRef);
        AudioObjectPropertyAddress nameAddr = {
            kAudioDevicePropertyDeviceNameCFString,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        AudioObjectGetPropertyData(devID, &nameAddr, 0, NULL, &nameSize, &nameRef);
        if (nameRef) {
            [names addObject:(__bridge_transfer NSString*)nameRef];
        }
    }

    free(deviceIDs);
    return names;
}

// ── SettingsViewController ─────────────────────────────────────────────────

@interface SettingsViewController ()
@property (nonatomic, strong) NSPopUpButton* inputDevicePopup;
@property (nonatomic, strong) NSPopUpButton* outputDevicePopup;
@property (nonatomic, strong) NSPopUpButton* bufferSizePopup;
@property (nonatomic, strong) NSTextField*   sampleRateLabel;
@end

@implementation SettingsViewController

- (void)loadView {
    self.view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 1024, 768)];
    self.view.wantsLayer = YES;
    self.view.layer.backgroundColor = S1ThemeBG().CGColor;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    [self buildUI];
    [self refreshDeviceLists];
}

- (void)buildUI {
    NSView* root = self.view;

    // ── Title ──────────────────────────────────────────────────────────────
    NSTextField* title = [NSTextField labelWithString:@"设置"];
    title.translatesAutoresizingMaskIntoConstraints = NO;
    title.font = [NSFont systemFontOfSize:28 weight:NSFontWeightBold];
    title.textColor = S1ThemeTextPrimary();
    [root addSubview:title];

    // ── Card panel ────────────────────────────────────────────────────────
    NSView* card = [[NSView alloc] init];
    card.translatesAutoresizingMaskIntoConstraints = NO;
    card.wantsLayer = YES;
    card.layer.backgroundColor = S1ThemeCardBG().CGColor;
    card.layer.cornerRadius = 12.0;
    card.layer.borderColor = [NSColor colorWithWhite:1 alpha:0.08].CGColor;
    card.layer.borderWidth = 1.0;
    [root addSubview:card];

    // Section header
    NSTextField* audioHeader = [self sectionHeader:@"音频设备"];
    [card addSubview:audioHeader];

    // ── Input Device ──────────────────────────────────────────────────────
    NSTextField* inputLabel = [self rowLabel:@"输入设备"];
    [card addSubview:inputLabel];

    _inputDevicePopup = [[NSPopUpButton alloc] init];
    _inputDevicePopup.translatesAutoresizingMaskIntoConstraints = NO;
    [card addSubview:_inputDevicePopup];

    // ── Output Device ─────────────────────────────────────────────────────
    NSTextField* outputLabel = [self rowLabel:@"输出设备"];
    [card addSubview:outputLabel];

    _outputDevicePopup = [[NSPopUpButton alloc] init];
    _outputDevicePopup.translatesAutoresizingMaskIntoConstraints = NO;
    [card addSubview:_outputDevicePopup];

    // ── Separator ─────────────────────────────────────────────────────────
    NSBox* sep = [[NSBox alloc] init];
    sep.translatesAutoresizingMaskIntoConstraints = NO;
    sep.boxType = NSBoxSeparator;
    [card addSubview:sep];

    // ── Buffer Size ───────────────────────────────────────────────────────
    NSTextField* bufHeader = [self sectionHeader:@"缓冲区与延迟"];
    [card addSubview:bufHeader];

    NSTextField* bufLabel = [self rowLabel:@"缓冲区大小"];
    [card addSubview:bufLabel];

    _bufferSizePopup = [[NSPopUpButton alloc] init];
    _bufferSizePopup.translatesAutoresizingMaskIntoConstraints = NO;
    [_bufferSizePopup addItemsWithTitles:@[@"64 samples (~1.3 ms)",
                                           @"128 samples (~2.7 ms)",
                                           @"256 samples (~5.3 ms)",
                                           @"512 samples (~10.7 ms)"]];
    [_bufferSizePopup selectItemAtIndex:2]; // default 256
    [card addSubview:_bufferSizePopup];

    // ── Sample Rate (display only) ────────────────────────────────────────
    NSTextField* srLabel = [self rowLabel:@"采样率"];
    [card addSubview:srLabel];

    _sampleRateLabel = [NSTextField labelWithString:@"48000 Hz"];
    _sampleRateLabel.translatesAutoresizingMaskIntoConstraints = NO;
    _sampleRateLabel.font = [NSFont monospacedSystemFontOfSize:13 weight:NSFontWeightRegular];
    _sampleRateLabel.textColor = S1ThemeAccentBlue();
    [card addSubview:_sampleRateLabel];

    // ── Back button ───────────────────────────────────────────────────────
    NSButton* backBtn = [NSButton buttonWithTitle:@"← 返回" target:self action:@selector(backTapped:)];
    backBtn.translatesAutoresizingMaskIntoConstraints = NO;
    backBtn.bezelStyle = NSBezelStyleRegularSquare;
    backBtn.wantsLayer = YES;
    backBtn.layer.cornerRadius = 8;
    backBtn.layer.backgroundColor = [NSColor colorWithWhite:0.18 alpha:1].CGColor;
    backBtn.bordered = NO;
    NSMutableAttributedString* backAttr = [[NSMutableAttributedString alloc]
        initWithString:@"← 返回"];
    [backAttr addAttribute:NSForegroundColorAttributeName
                     value:S1ThemeTextPrimary()
                     range:NSMakeRange(0, backAttr.length)];
    backBtn.attributedTitle = backAttr;
    [root addSubview:backBtn];

    // ── Constraints ──────────────────────────────────────────────────────
    CGFloat cardW = 520, rowH = 32, labelW = 100, popupW = 300, pad = 24;

    [NSLayoutConstraint activateConstraints:@[
        // Title
        [title.topAnchor constraintEqualToAnchor:root.topAnchor constant:40],
        [title.centerXAnchor constraintEqualToAnchor:root.centerXAnchor],

        // Card centered below title
        [card.topAnchor constraintEqualToAnchor:title.bottomAnchor constant:24],
        [card.centerXAnchor constraintEqualToAnchor:root.centerXAnchor],
        [card.widthAnchor constraintEqualToConstant:cardW],

        // Audio section header
        [audioHeader.topAnchor constraintEqualToAnchor:card.topAnchor constant:pad],
        [audioHeader.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:pad],

        // Input row
        [inputLabel.topAnchor constraintEqualToAnchor:audioHeader.bottomAnchor constant:14],
        [inputLabel.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:pad],
        [inputLabel.widthAnchor constraintEqualToConstant:labelW],
        [inputLabel.heightAnchor constraintEqualToConstant:rowH],
        [_inputDevicePopup.centerYAnchor constraintEqualToAnchor:inputLabel.centerYAnchor],
        [_inputDevicePopup.leadingAnchor constraintEqualToAnchor:inputLabel.trailingAnchor constant:12],
        [_inputDevicePopup.widthAnchor constraintEqualToConstant:popupW],

        // Output row
        [outputLabel.topAnchor constraintEqualToAnchor:inputLabel.bottomAnchor constant:12],
        [outputLabel.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:pad],
        [outputLabel.widthAnchor constraintEqualToConstant:labelW],
        [outputLabel.heightAnchor constraintEqualToConstant:rowH],
        [_outputDevicePopup.centerYAnchor constraintEqualToAnchor:outputLabel.centerYAnchor],
        [_outputDevicePopup.leadingAnchor constraintEqualToAnchor:outputLabel.trailingAnchor constant:12],
        [_outputDevicePopup.widthAnchor constraintEqualToConstant:popupW],

        // Separator
        [sep.topAnchor constraintEqualToAnchor:outputLabel.bottomAnchor constant:20],
        [sep.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:pad],
        [sep.trailingAnchor constraintEqualToAnchor:card.trailingAnchor constant:-pad],

        // Buffer section header
        [bufHeader.topAnchor constraintEqualToAnchor:sep.bottomAnchor constant:20],
        [bufHeader.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:pad],

        // Buffer row
        [bufLabel.topAnchor constraintEqualToAnchor:bufHeader.bottomAnchor constant:14],
        [bufLabel.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:pad],
        [bufLabel.widthAnchor constraintEqualToConstant:labelW],
        [bufLabel.heightAnchor constraintEqualToConstant:rowH],
        [_bufferSizePopup.centerYAnchor constraintEqualToAnchor:bufLabel.centerYAnchor],
        [_bufferSizePopup.leadingAnchor constraintEqualToAnchor:bufLabel.trailingAnchor constant:12],
        [_bufferSizePopup.widthAnchor constraintEqualToConstant:popupW],

        // Sample rate row
        [srLabel.topAnchor constraintEqualToAnchor:bufLabel.bottomAnchor constant:12],
        [srLabel.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:pad],
        [srLabel.widthAnchor constraintEqualToConstant:labelW],
        [srLabel.heightAnchor constraintEqualToConstant:rowH],
        [_sampleRateLabel.centerYAnchor constraintEqualToAnchor:srLabel.centerYAnchor],
        [_sampleRateLabel.leadingAnchor constraintEqualToAnchor:srLabel.trailingAnchor constant:12],

        // Card bottom
        [card.bottomAnchor constraintEqualToAnchor:srLabel.bottomAnchor constant:pad],

        // Back button
        [backBtn.topAnchor constraintEqualToAnchor:card.bottomAnchor constant:24],
        [backBtn.centerXAnchor constraintEqualToAnchor:root.centerXAnchor],
        [backBtn.widthAnchor constraintEqualToConstant:120],
        [backBtn.heightAnchor constraintEqualToConstant:38],
    ]];
}

// ── Helpers ────────────────────────────────────────────────────────────────

- (NSTextField*)sectionHeader:(NSString*)text {
    NSTextField* lbl = [NSTextField labelWithString:text];
    lbl.translatesAutoresizingMaskIntoConstraints = NO;
    lbl.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
    lbl.textColor = [NSColor colorWithWhite:0.65 alpha:1];
    return lbl;
}

- (NSTextField*)rowLabel:(NSString*)text {
    NSTextField* lbl = [NSTextField labelWithString:text];
    lbl.translatesAutoresizingMaskIntoConstraints = NO;
    lbl.font = [NSFont systemFontOfSize:13 weight:NSFontWeightRegular];
    lbl.textColor = [NSColor colorWithWhite:0.8 alpha:1];
    return lbl;
}

- (void)refreshDeviceLists {
    NSArray<NSString*>* inputs  = EnumerateAudioDevices(true);
    NSArray<NSString*>* outputs = EnumerateAudioDevices(false);

    [_inputDevicePopup removeAllItems];
    if (inputs.count > 0) {
        [_inputDevicePopup addItemsWithTitles:inputs];
    } else {
        [_inputDevicePopup addItemWithTitle:@"(无可用设备)"];
    }

    [_outputDevicePopup removeAllItems];
    if (outputs.count > 0) {
        [_outputDevicePopup addItemsWithTitles:outputs];
    } else {
        [_outputDevicePopup addItemWithTitle:@"(无可用设备)"];
    }
}

// ── Actions ────────────────────────────────────────────────────────────────

- (void)backTapped:(id)sender {
    if (self.onClose) self.onClose();
    else if (self.onBack) self.onBack();
}

@end
