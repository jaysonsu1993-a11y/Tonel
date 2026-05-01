#pragma once
#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

@interface HomeViewController : NSViewController

@property (nonatomic, copy, nullable) void (^onCreateRoom)(void);
@property (nonatomic, copy, nullable) void (^onJoinRoom)(void);
@property (nonatomic, copy, nullable) void (^onSettings)(void);

@end

NS_ASSUME_NONNULL_END
