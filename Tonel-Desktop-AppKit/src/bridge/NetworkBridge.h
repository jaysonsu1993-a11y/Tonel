// NetworkBridge.h — Objective-C interface to the signaling layer
#pragma once
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// ── Delegate ──────────────────────────────────────────────────────────────────

@protocol NetworkBridgeDelegate <NSObject>
@optional
- (void)networkBridgeConnected;
- (void)networkBridgeDisconnected;
- (void)networkBridgeError:(NSString*)error;
- (void)networkBridgeRoomCreated:(NSString*)roomCode;
- (void)networkBridgeRoomJoinFailed:(NSString*)errorMessage;
- (void)networkBridgeRoomJoined:(NSString*)roomCode;
- (void)networkBridgePeerJoined:(NSString*)userId ip:(NSString*)ip port:(int)port;
- (void)networkBridgePeerLeft:(NSString*)userId;
- (void)networkBridgePeerList:(NSArray<NSDictionary*>*)peers roomCode:(NSString*)roomCode;
- (void)networkBridgeLatencyUpdated:(int)ms;
@end

// ── NetworkBridge ─────────────────────────────────────────────────────────────

@interface NetworkBridge : NSObject

+ (instancetype)shared;

// ── Server connection ─────────────────────────────────────────────────────────
- (void)connectToHost:(NSString*)host port:(int)port;
- (void)disconnect;
- (BOOL)isConnected;

// ── Room actions ──────────────────────────────────────────────────────────────
- (void)createRoom:(NSString*)roomId userId:(NSString*)userId password:(NSString*)password;
- (void)joinRoom  :(NSString*)roomId userId:(NSString*)userId password:(NSString*)password;
- (void)leaveRoom :(NSString*)roomId userId:(NSString*)userId;

@property (nonatomic, weak, nullable) id<NetworkBridgeDelegate> delegate;

@end

NS_ASSUME_NONNULL_END
