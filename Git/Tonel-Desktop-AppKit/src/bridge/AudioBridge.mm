// AudioBridge.mm — miniaudio engine wrapped in Objective-C
//
// v1.0.9: split the previous single duplex ma_device into two independent
// devices — one capture, one playback. The duplex form was fragile on
// macOS: switching to an input or output device that the system can't
// fold into a single ma_device_init() call (different sample-rate clocks,
// devices that don't expose the duplex direction, etc.) silently failed
// and `setInputDeviceIndex` / `setOutputDeviceIndex` looked broken from
// the UI's perspective. With separate devices, changing one direction
// only re-inits that direction; the other keeps streaming.
//
// MINIAUDIO_IMPLEMENTATION must live in exactly one TU — this file.

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
    ma_device   captureDevice;
    ma_device   playbackDevice;
    bool        contextInited       = false;
    bool        captureInited       = false;
    bool        playbackInited      = false;

    std::atomic<float> inputLevel{ 0.0f };
    std::atomic<float> outputVolume{ 1.0f };
    std::atomic<bool>  muted{ false };

    int inputDeviceIndex  = -1;   // -1 = system default
    int outputDeviceIndex = -1;

    // Capture-side accumulator: stereo f32 → mono int16 → ship every 240 samples.
    int16_t accumBuf[kSendFrameSize];
    int     accumCount = 0;

    // MixerBridge for network audio (not retained — caller manages lifetime)
    __unsafe_unretained MixerBridge* mixerBridge = nil;

    // Weak ref back to the ObjC object (not retained — bridge owns state)
    __unsafe_unretained id owner = nil;
};

// ── Capture callback (real-time audio thread, capture device) ─────────────────
//
// Reads stereo mic input, computes RMS for the level meter, downmixes to mono
// int16 PCM, and ships 5ms (240-sample) frames to the mixer when connected.

static void captureCallback(ma_device* dev, void* /*output*/,
                            const void* input, ma_uint32 frameCount)
{
    AudioBridgeState* s = static_cast<AudioBridgeState*>(dev->pUserData);
    if (!s || !input) return;

    const int ch = 2;
    const float* in = static_cast<const float*>(input);
    MixerBridge* mixer = s->mixerBridge;
    bool mixerActive = (mixer != nil && [mixer isConnected]);

    // Input level metering (RMS with EMA smoothing).
    float sumSq = 0.0f;
    ma_uint32 totalSamples = frameCount * ch;
    for (ma_uint32 i = 0; i < totalSamples; ++i) {
        sumSq += in[i] * in[i];
    }
    float rms = sumSq > 0.0f ? std::sqrt(sumSq / static_cast<float>(totalSamples)) : 0.0f;
    float prev = s->inputLevel.load(std::memory_order_relaxed);
    s->inputLevel.store(prev * 0.8f + rms * 0.2f, std::memory_order_release);

    // Send mic audio to the mixer (only when we have a live connection).
    if (!s->muted.load() && mixerActive) {
        for (ma_uint32 i = 0; i < frameCount; i++) {
            float mono = (in[i * ch] + in[i * ch + 1]) * 0.5f;
            mono = std::max(-1.0f, std::min(1.0f, mono));
            s->accumBuf[s->accumCount++] = static_cast<int16_t>(mono * 32767.0f);

            if (s->accumCount >= kSendFrameSize) {
                [mixer sendAudioSamples:s->accumBuf count:kSendFrameSize];
                s->accumCount = 0;
            }
        }
    }
}

// ── Playback callback (real-time audio thread, playback device) ───────────────
//
// Reads mono float samples from the mixer's RX ring buffer (or zeros when
// not connected / not yet primed), applies the master volume, and writes
// stereo output. Local mic loopback was dropped along with the duplex
// device — the home screen no longer hears the mic, which avoids the
// feedback loop the old loopback used to cause when the user forgot to
// mute before joining a room.

static void playbackCallback(ma_device* dev, void* output,
                             const void* /*input*/, ma_uint32 frameCount)
{
    AudioBridgeState* s = static_cast<AudioBridgeState*>(dev->pUserData);
    if (!s || !output) return;

    const int ch = 2;
    float* out = static_cast<float*>(output);
    MixerBridge* mixer = s->mixerBridge;
    bool mixerActive = (mixer != nil && [mixer isConnected]);

    if (!mixerActive) {
        std::memset(out, 0, frameCount * ch * sizeof(float));
        return;
    }

    float monoBuf[1024];
    int got = [mixer readMixedAudio:monoBuf maxSamples:static_cast<int>(frameCount)];
    float vol = s->outputVolume.load();
    for (ma_uint32 i = 0; i < frameCount; i++) {
        float sample = (static_cast<int>(i) < got) ? monoBuf[i] * vol : 0.0f;
        out[i * ch]     = sample;
        out[i * ch + 1] = sample;
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

// ── Context bootstrap ─────────────────────────────────────────────────────────

- (BOOL)ensureContext {
    if (_state->contextInited) return YES;
    if (ma_context_init(nullptr, 0, nullptr, &_state->context) != MA_SUCCESS) {
        NSLog(@"[AudioBridge] ma_context_init failed");
        return NO;
    }
    _state->contextInited = true;
    return YES;
}

// ── Capture device ────────────────────────────────────────────────────────────

- (BOOL)initializeCapture {
    if (_state->captureInited) return YES;
    if (![self ensureContext]) return NO;

    ma_device_config cfg = ma_device_config_init(ma_device_type_capture);
    cfg.sampleRate          = 48000;
    cfg.performanceProfile  = ma_performance_profile_low_latency;
    cfg.periodSizeInFrames  = 128;       // 2.67 ms @ 48 kHz
    cfg.capture.format      = ma_format_f32;
    cfg.capture.channels    = 2;
    cfg.capture.shareMode   = ma_share_mode_shared;
    cfg.capture.pDeviceID   = [self deviceIdForType:ma_device_type_capture
                                              index:_state->inputDeviceIndex];
    cfg.dataCallback        = captureCallback;
    cfg.pUserData           = _state;

    if (ma_device_init(&_state->context, &cfg, &_state->captureDevice) != MA_SUCCESS) {
        NSLog(@"[AudioBridge] capture device init failed (index=%d)", _state->inputDeviceIndex);
        return NO;
    }
    _state->captureInited = true;
    NSLog(@"[AudioBridge] capture initialized — %s", _state->captureDevice.capture.name);
    return YES;
}

// ── Playback device ───────────────────────────────────────────────────────────

- (BOOL)initializePlayback {
    if (_state->playbackInited) return YES;
    if (![self ensureContext]) return NO;

    ma_device_config cfg = ma_device_config_init(ma_device_type_playback);
    cfg.sampleRate          = 48000;
    cfg.performanceProfile  = ma_performance_profile_low_latency;
    cfg.periodSizeInFrames  = 128;       // 2.67 ms @ 48 kHz
    cfg.playback.format     = ma_format_f32;
    cfg.playback.channels   = 2;
    cfg.playback.shareMode  = ma_share_mode_shared;
    cfg.playback.pDeviceID  = [self deviceIdForType:ma_device_type_playback
                                              index:_state->outputDeviceIndex];
    cfg.dataCallback        = playbackCallback;
    cfg.pUserData           = _state;

    if (ma_device_init(&_state->context, &cfg, &_state->playbackDevice) != MA_SUCCESS) {
        NSLog(@"[AudioBridge] playback device init failed (index=%d)", _state->outputDeviceIndex);
        return NO;
    }
    _state->playbackInited = true;
    NSLog(@"[AudioBridge] playback initialized — %s", _state->playbackDevice.playback.name);
    return YES;
}

// Header-declared init combines both directions; if either fails, the other
// stays usable so partial functionality is preserved.
- (BOOL)initialize {
    BOOL c = [self initializeCapture];
    BOOL p = [self initializePlayback];
    return c && p;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

- (void)start {
    [self initialize];

    if (_state->captureInited && !ma_device_is_started(&_state->captureDevice)) {
        if (ma_device_start(&_state->captureDevice) != MA_SUCCESS) {
            NSLog(@"[AudioBridge] capture start failed");
        }
    }
    if (_state->playbackInited && !ma_device_is_started(&_state->playbackDevice)) {
        if (ma_device_start(&_state->playbackDevice) != MA_SUCCESS) {
            NSLog(@"[AudioBridge] playback start failed");
        }
    }
    NSLog(@"[AudioBridge] started (capture=%d, playback=%d)",
          (int)_state->captureInited, (int)_state->playbackInited);

    dispatch_async(dispatch_get_main_queue(), ^{
        [self startLevelTimer];
    });
}

- (void)stop {
    [self stopLevelTimer];
    if (_state->captureInited && ma_device_is_started(&_state->captureDevice)) {
        ma_device_stop(&_state->captureDevice);
    }
    if (_state->playbackInited && ma_device_is_started(&_state->playbackDevice)) {
        ma_device_stop(&_state->playbackDevice);
    }
    NSLog(@"[AudioBridge] stopped");
}

- (void)teardownCapture {
    if (_state->captureInited) {
        if (ma_device_is_started(&_state->captureDevice)) {
            ma_device_stop(&_state->captureDevice);
        }
        ma_device_uninit(&_state->captureDevice);
        _state->captureInited = false;
        _state->accumCount = 0;
    }
}

- (void)teardownPlayback {
    if (_state->playbackInited) {
        if (ma_device_is_started(&_state->playbackDevice)) {
            ma_device_stop(&_state->playbackDevice);
        }
        ma_device_uninit(&_state->playbackDevice);
        _state->playbackInited = false;
    }
}

- (void)shutdown {
    [self stop];
    [self teardownCapture];
    [self teardownPlayback];
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
    if (![self ensureContext]) return result;

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
//
// Only the affected direction is torn down and re-initialized. The other
// direction keeps streaming, so audio doesn't drop out on the speaker just
// because the user picked a different microphone.

- (void)setInputDeviceIndex:(NSInteger)index {
    _state->inputDeviceIndex = (int)index;
    BOOL wasRunning = _state->captureInited && ma_device_is_started(&_state->captureDevice);
    [self teardownCapture];
    if (![self initializeCapture]) {
        NSLog(@"[AudioBridge] setInputDeviceIndex: failed to init new capture device, falling back to default");
        _state->inputDeviceIndex = -1;
        [self initializeCapture];
    }
    if (wasRunning && _state->captureInited) {
        ma_device_start(&_state->captureDevice);
    }
    NSLog(@"[AudioBridge] Input device → index %ld (%s)", (long)index,
          _state->captureInited ? _state->captureDevice.capture.name : "unavailable");
}

- (void)setOutputDeviceIndex:(NSInteger)index {
    _state->outputDeviceIndex = (int)index;
    BOOL wasRunning = _state->playbackInited && ma_device_is_started(&_state->playbackDevice);
    [self teardownPlayback];
    if (![self initializePlayback]) {
        NSLog(@"[AudioBridge] setOutputDeviceIndex: failed to init new playback device, falling back to default");
        _state->outputDeviceIndex = -1;
        [self initializePlayback];
    }
    if (wasRunning && _state->playbackInited) {
        ma_device_start(&_state->playbackDevice);
    }
    NSLog(@"[AudioBridge] Output device → index %ld (%s)", (long)index,
          _state->playbackInited ? _state->playbackDevice.playback.name : "unavailable");
}

- (NSInteger)currentInputDeviceIndex  { return _state->inputDeviceIndex; }
- (NSInteger)currentOutputDeviceIndex { return _state->outputDeviceIndex; }

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
    if (![self ensureContext]) return nullptr;

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
    thread_local ma_device_id storedIdCapture;
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
