// SettingsViewController.h — Audio settings (CoreAudio device enumeration)
#pragma once
#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

@interface SettingsViewController : NSViewController

/// Called when user closes settings.
@property (nonatomic, copy, nullable) void (^onClose)(void);

/// Alias kept for compatibility.
@property (nonatomic, copy, nullable) void (^onBack)(void);

@end

NS_ASSUME_NONNULL_END
