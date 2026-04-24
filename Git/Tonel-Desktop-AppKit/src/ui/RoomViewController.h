// RoomViewController.h — Active rehearsal room view
#pragma once
#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

@interface RoomViewController : NSViewController

@property (nonatomic, copy, nullable) void (^onLeaveRoom)(void);
@property (nonatomic, copy, nullable) void (^onOpenSettings)(void);

/// Reload participant grid and status bar from AppState.
- (void)refresh;

/// Called when app is terminating — stops timers / audio.
- (void)cleanup;

@end

NS_ASSUME_NONNULL_END
