// AudioBridge.mm — miniaudio duplex engine wrapped in Objective-C
//
// Implements its own audio engine inline so we avoid the JUCE transitive
// dependency chain that MiniaudioEngine.cpp would pull in through AudioRouter.h.
// The miniaudio header is header-only; MINIAUDIO_IMPLEMENTATION must be defined
// in exactly one translation unit — this file.

#define MINIAUDIO_IMPLEMENTATION
#import "AudioBridge.h"
#import "MixerBridge.h"
#include <miniaudio.h>
#include "../AppState.h"
#include <atomic>
#include <cmath>
#include <cstring>
#include <mutex>
#include <vector>

// ── Internal state ────────────────────────────────────────────────────────────

static constexpr int kSendFrameSize = 240;  // 5ms @ 48kHz mono — matches server audio_frames_

struct AudioBridgeState {
    ma_context  context;
    ma_device   device;
    bool        contextInited = false;
    bool        deviceInited  = false;

    std::atomic<float> inputLevel{ 0.0f };
    std::atomic<float> outputVolume{ 1.0f };
    std::atomic<bool>  muted{ false };

    int inputDeviceIndex  = -1;   // -1 = system default
    int outputDeviceIndex = -1;

    // Accumulation buffer: stereo f32 → mono int16, send when 240 samples ready
    int16_t accumBuf[kSendFrameSize];
    int     accumCount = 0;

    // MixerBridge for network audio (not retained — caller manages lifetime)
    __unsafe_unretained MixerBridge* mixerBridge = nil;

    // Weak ref back to the ObjC object (not retained — bridge owns state)
    __unsafe_unretained id owner = nil;
};

// ── Audio callback (called on real-time audio thread) ────────────────────────

static void audioDataCallback(ma_device* dev, void* output,
                              const void* input, ma_uint32 frameCount)
{
    AudioBridgeState* s = static_cast<AudioBridgeState*>(dev->pUserData);
    if (!s) return;

    const int ch = 2;
    const float* in = static_cast<const float*>(input);
    float* out = static_cast<float*>(output);
    MixerBridge* mixer = s->mixerBridge;
    bool mixerActive = (mixer != nil && [mixer isConnected]);

    // ── Input level metering (RMS with smoothing) ─────────────────────────
    if (input) {
        float sumSq = 0.0f;
        ma_uint32 totalSamples = frameCount * ch;
        for (ma_uint32 i = 0; i < totalSamples; ++i) {
            sumSq += in[i] * in[i];
        }
        float rms = sumSq > 0.0f ? std::sqrt(sumSq / static_cast<float>(totalSamples)) : 0.0f;
        float prev = s->inputLevel.load(std::memory_order_relaxed);
        s->inputLevel.store(prev * 0.8f + rms * 0.2f, std::memory_order_release);
    }

    // ── Send mic audio to mixer server ────────────────────────────────────
    if (input && !s->muted.load() && mixerActive) {
        for (ma_uint32 i = 0; i < frameCount; i++) {
            // Stereo f32 → mono int16
            float mono = (in[i * ch] + in[i * ch + 1]) * 0.5f;
            mono = std::max(-1.0f, std::min(1.0f, mono));
            s->accumBuf[s->accumCount++] = static_cast<int16_t>(mono * 32767.0f);

            if (s->accumCount >= kSendFrameSize) {
                [mixer sendAudioSamples:s->accumBuf count:kSendFrameSize];
                s->accumCount = 0;
            }
        }
    }

    // ── Playback ──────────────────────────────────────────────────────────
    if (output) {
        if (mixerActive) {
            // Read mixed audio from server (mono float) → stereo output
            float monoBuf[1024];
            int got = [mixer readMixedAudio:monoBuf maxSamples:static_cast<int>(frameCount)];
            float vol = s->outputVolume.load();
            for (ma_uint32 i = 0; i < frameCount; i++) {
                float sample = (static_cast<int>(i) < got) ? monoBuf[i] * vol : 0.0f;
                out[i * ch]     = sample;
                out[i * ch + 1] = sample;
            }
        } else {
            // Loopback fallback when not connected to mixer
            if (!s->muted.load() && input) {
                float vol = s->outputVolume.load();
                for (ma_uint32 i = 0; i < frameCount * ch; ++i) {
                    out[i] = in[i] * vol;
                }
            } else {
                std::memset(out, 0, frameCount * ch * sizeof(float));
            }
        }
    }
}

// ── AudioDeviceInfo ───────────────────────────────────────────────────────────

@implementation AudioDeviceInfo
@end

// ── AudioBridge ───────────────────────────────────────────────────────────────

@implementation AudioBridge {
    AudioBridgeState*  _state;
    NSTimer*           _levelTimer;
    dispatch_queue_t   _audioQueue;
}

+ (instancetype)shared {
    static AudioBridge* instance;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{ instance = [[AudioBridge alloc] init]; });
    return instance;
}

- (instancetype)init {
    if (self = [super init]) {
        _state = new AudioBridgeState();
        _state->owner = self;
        _audioQueue = dispatch_queue_create("com.s1.audio", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (void)dealloc {
    [self shutdown];
    delete _state;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

- (BOOL)initialize {
    if (_state->deviceInited) return YES;

    // Init context
    if (!_state->contextInited) {
        if (ma_context_init(nullptr, 0, nullptr, &_state->context) != MA_SUCCESS) {
            NSLog(@"[AudioBridge] ma_context_init failed");
            return NO;
        }
        _state->contextInited = true;
    }

    // Build duplex config
    ma_device_config cfg = ma_device_config_init(ma_device_type_duplex);
    cfg.sampleRate = 48000;
    cfg.performanceProfile = ma_performance_profile_low_latency;
    cfg.periodSizeInFrames = 128;  // 2.67ms @ 48kHz (validated in s1-mini)

    cfg.capture.format   = ma_format_f32;
    cfg.capture.channels = 2;
    cfg.capture.shareMode = ma_share_mode_shared;

    cfg.playback.format   = ma_format_f32;
    cfg.playback.channels = 2;
    cfg.playback.shareMode = ma_share_mode_shared;

    // Resolve device IDs (nil = default)
    const ma_device_id* captureId  = [self deviceIdForType:ma_device_type_capture
                                                      index:_state->inputDeviceIndex];
    const ma_device_id* playbackId = [self deviceIdForType:ma_device_type_playback
                                                      index:_state->outputDeviceIndex];
    cfg.capture.pDeviceID  = captureId;
    cfg.playback.pDeviceID = playbackId;

    cfg.dataCallback = audioDataCallback;
    cfg.pUserData    = _state;

    if (ma_device_init(&_state->context, &cfg, &_state->device) != MA_SUCCESS) {
        NSLog(@"[AudioBridge] ma_device_init failed");
        return NO;
    }

    _state->deviceInited = true;
    NSLog(@"[AudioBridge] initialized — capture: %s / playback: %s",
          _state->device.capture.name, _state->device.playback.name);
    return YES;
}

- (void)start {
    if (!_state->deviceInited && ![self initialize]) return;
    if (ma_device_is_started(&_state->device)) return;

    if (ma_device_start(&_state->device) != MA_SUCCESS) {
        NSLog(@"[AudioBridge] ma_device_start failed");
        return;
    }
    NSLog(@"[AudioBridge] started");

    // Poll input level on main thread every 50 ms
    dispatch_async(dispatch_get_main_queue(), ^{
        [self startLevelTimer];
    });
}

- (void)stop {
    [self stopLevelTimer];
    if (_state->deviceInited && ma_device_is_started(&_state->device)) {
        ma_device_stop(&_state->device);
        NSLog(@"[AudioBridge] stopped");
    }
}

- (void)shutdown {
    [self stop];
    if (_state->deviceInited) {
        ma_device_uninit(&_state->device);
        _state->deviceInited = false;
    }
    if (_state->contextInited) {
        ma_context_uninit(&_state->context);
        _state->contextInited = false;
    }
    NSLog(@"[AudioBridge] shutdown");
}

// ── Device enumeration ────────────────────────────────────────────────────────

- (NSArray<AudioDeviceInfo*>*)inputDevices {
    return [self enumerateDevicesOfType:ma_device_type_capture];
}

- (NSArray<AudioDeviceInfo*>*)outputDevices {
    return [self enumerateDevicesOfType:ma_device_type_playback];
}

- (NSArray<AudioDeviceInfo*>*)enumerateDevicesOfType:(ma_device_type)type {
    NSMutableArray* result = [NSMutableArray array];

    if (!_state->contextInited) {
        if (ma_context_init(nullptr, 0, nullptr, &_state->context) != MA_SUCCESS)
            return result;
        _state->contextInited = true;
    }

    ma_device_info* playbackDevices = nullptr;
    ma_device_info* captureDevices  = nullptr;
    ma_uint32 playbackCount = 0;
    ma_uint32 captureCount  = 0;

    if (ma_context_get_devices(&_state->context,
                               &playbackDevices, &playbackCount,
                               &captureDevices,  &captureCount) != MA_SUCCESS) {
        return result;
    }

    ma_device_info* devices = (type == ma_device_type_playback)
                                  ? playbackDevices : captureDevices;
    ma_uint32 count = (type == ma_device_type_playback)
                          ? playbackCount : captureCount;

    for (ma_uint32 i = 0; i < count; ++i) {
        AudioDeviceInfo* info = [[AudioDeviceInfo alloc] init];
        info.name      = [NSString stringWithUTF8String:devices[i].name];
        info.index     = (NSInteger)i;
        info.isDefault = (i == 0);
        [result addObject:info];
    }
    return result;
}

// ── Device selection ──────────────────────────────────────────────────────────

- (void)setInputDeviceIndex:(NSInteger)index {
    _state->inputDeviceIndex = (int)index;
    if (_state->deviceInited) {
        BOOL wasRunning = ma_device_is_started(&_state->device);
        [self stop];
        ma_device_uninit(&_state->device);
        _state->deviceInited = false;
        [self initialize];
        if (wasRunning) [self start];
    }
}

- (void)setOutputDeviceIndex:(NSInteger)index {
    _state->outputDeviceIndex = (int)index;
    if (_state->deviceInited) {
        BOOL wasRunning = ma_device_is_started(&_state->device);
        [self stop];
        ma_device_uninit(&_state->device);
        _state->deviceInited = false;
        [self initialize];
        if (wasRunning) [self start];
    }
}

// ── Volume & mute ─────────────────────────────────────────────────────────────

- (void)setOutputVolume:(float)volume {
    _state->outputVolume.store(volume);
}

- (void)setMuted:(BOOL)muted {
    _state->muted.store((bool)muted);
}

// ── Level meter ───────────────────────────────────────────────────────────────

- (float)inputLevel {
    return _state->inputLevel.load(std::memory_order_acquire);
}

- (void)startLevelTimer {
    [_levelTimer invalidate];
    _levelTimer = [NSTimer scheduledTimerWithTimeInterval:0.05
                                                   target:self
                                                 selector:@selector(pollInputLevel)
                                                 userInfo:nil
                                                  repeats:YES];
}

- (void)stopLevelTimer {
    dispatch_async(dispatch_get_main_queue(), ^{
        [self->_levelTimer invalidate];
        self->_levelTimer = nil;
    });
}

- (void)pollInputLevel {
    float level = _state->inputLevel.load(std::memory_order_acquire);
    AppState::shared().setInputLevel(level);
    id<AudioBridgeDelegate> d = self.delegate;
    if ([d respondsToSelector:@selector(audioBridgeInputLevelChanged:)]) {
        [d audioBridgeInputLevelChanged:level];
    }
}

// ── Mixer bridge ──────────────────────────────────────────────────────────────

- (void)setMixerBridge:(MixerBridge*)bridge {
    _state->mixerBridge = bridge;
    _state->accumCount  = 0;
}

// ── Private helper ────────────────────────────────────────────────────────────

/// Returns pointer to a thread-safely stored ma_device_id, or nullptr for default.
- (const ma_device_id*)deviceIdForType:(ma_device_type)type index:(int)index {
    if (index < 0) return nullptr;
    if (!_state->contextInited) return nullptr;

    ma_device_info* playbackDevices = nullptr;
    ma_device_info* captureDevices  = nullptr;
    ma_uint32 playbackCount = 0, captureCount = 0;

    if (ma_context_get_devices(&_state->context,
                               &playbackDevices, &playbackCount,
                               &captureDevices,  &captureCount) != MA_SUCCESS)
        return nullptr;

    ma_device_info* devs  = (type == ma_device_type_playback) ? playbackDevices : captureDevices;
    ma_uint32       count = (type == ma_device_type_playback) ? playbackCount   : captureCount;

    if ((ma_uint32)index >= count) return nullptr;

    // Thread-local storage — safe because return value is only used immediately
    // within the same call stack before ma_device_init.
    thread_local ma_device_id storedIdCapture;   // per-thread, no cross-thread race
    thread_local ma_device_id storedIdPlayback;

    if (type == ma_device_type_playback) {
        storedIdPlayback = devs[index].id;
        return &storedIdPlayback;
    } else {
        storedIdCapture = devs[index].id;
        return &storedIdCapture;
    }
}

@end
