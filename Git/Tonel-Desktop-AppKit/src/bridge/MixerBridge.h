// MixerBridge.h — TCP control + UDP audio transport to Tonel mixer server
#pragma once
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@protocol MixerBridgeDelegate <NSObject>
@optional
- (void)mixerBridgeConnected;
- (void)mixerBridgeDisconnected;
- (void)mixerBridgeError:(NSString*)error;
@end

@interface MixerBridge : NSObject

+ (instancetype)shared;

/// Connect to mixer server and join a room. Call after signaling room is created/joined.
- (void)connectToRoom:(NSString*)roomId userId:(NSString*)userId;

/// Disconnect from mixer server and leave the room.
- (void)disconnect;

- (BOOL)isConnected;

/// Called from audio thread: send mono PCM16 samples to mixer via UDP.
- (void)sendAudioSamples:(const int16_t*)samples count:(int)count;

/// Called from audio thread: read mixed audio into mono float buffer.
/// Returns number of samples actually read.
- (int)readMixedAudio:(float*)output maxSamples:(int)maxSamples;

@property (nonatomic, weak, nullable) id<MixerBridgeDelegate> delegate;

@end

NS_ASSUME_NONNULL_END
