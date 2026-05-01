// MainWindowController.h — Root NSWindowController; manages view transitions
#pragma once
#import <Cocoa/Cocoa.h>

@class HomeViewController;
@class RoomViewController;
@class SettingsViewController;

NS_ASSUME_NONNULL_BEGIN

@interface MainWindowController : NSWindowController

// ── View controllers ──────────────────────────────────────────────────────
@property (nonatomic, strong, readonly) HomeViewController*     homeVC;
@property (nonatomic, strong, readonly) RoomViewController*     roomVC;
@property (nonatomic, strong, readonly) SettingsViewController* settingsVC;

// ── Navigation ────────────────────────────────────────────────────────────
- (void)showHome;
- (void)showRoom;
- (void)showSettings;

// ── Lifecycle ─────────────────────────────────────────────────────────────
- (void)cleanup;

@end

NS_ASSUME_NONNULL_END
