// AudioBridge.h — Objective-C wrapper around miniaudio duplex engine
#pragma once
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// ── Delegate ──────────────────────────────────────────────────────────────────

@protocol AudioBridgeDelegate <NSObject>
@optional
/// Called on main thread roughly every 50 ms with the smoothed RMS level (0–1).
- (void)audioBridgeInputLevelChanged:(float)level;
@end

// ── Device info ───────────────────────────────────────────────────────────────

@interface AudioDeviceInfo : NSObject
@property (nonatomic, copy)   NSString*  name;
@property (nonatomic, assign) NSInteger  index;
@property (nonatomic, assign) BOOL       isDefault;
@end

// ── AudioBridge ───────────────────────────────────────────────────────────────

@interface AudioBridge : NSObject

+ (instancetype)shared;

// ── Lifecycle ─────────────────────────────────────────────────────────────────
- (BOOL)initialize;
- (void)start;
- (void)stop;
- (void)shutdown;

// ── Device selection ──────────────────────────────────────────────────────────
- (NSArray<AudioDeviceInfo*>*)inputDevices;
- (NSArray<AudioDeviceInfo*>*)outputDevices;
- (void)setInputDeviceIndex:(NSInteger)index;
- (void)setOutputDeviceIndex:(NSInteger)index;

// ── Volume & mute ─────────────────────────────────────────────────────────────
- (void)setOutputVolume:(float)volume;   // 0.0 – 1.0
- (void)setMuted:(BOOL)muted;

// ── Level meter ───────────────────────────────────────────────────────────────
@property (atomic, readonly) float inputLevel;  // 0.0 – 1.0, updated each callback

@property (nonatomic, weak, nullable) id<AudioBridgeDelegate> delegate;

@end

NS_ASSUME_NONNULL_END
