#pragma once
#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

@interface CreateRoomViewController : NSViewController

/// Called when the user taps 创建 with a room code and optional password.
@property (nonatomic, copy, nullable) void (^onConfirm)(NSString* roomCode, NSString* password);
/// Called when the user taps 取消.
@property (nonatomic, copy, nullable) void (^onCancel)(void);

@end

NS_ASSUME_NONNULL_END
