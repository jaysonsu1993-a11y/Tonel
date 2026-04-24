// MiniaudioEngine.cpp - Tonel-mini audio engine using miniaudio
#define MINIAUDIO_IMPLEMENTATION
#include "MiniaudioEngine.h"
#include "network/AudioRouter.h"
#include <cstdio>
#include <mutex>

MiniaudioEngine::MiniaudioEngine()
{
    printf("MiniaudioEngine created (Tonel-mini mode)\n");
}

MiniaudioEngine::~MiniaudioEngine()
{
    shutdown();
}

bool MiniaudioEngine::initialize()
{
    if (running_.load()) {
        printf("MiniaudioEngine: already initialized and running\n");
        return true;
    }

    ma_device_config config = ma_device_config_init(ma_device_type_duplex);
    config.sampleRate = 48000;
    config.performanceProfile = ma_performance_profile_low_latency;

    // Capture (microphone input)
    config.capture.format = ma_format_f32;
    config.capture.channels = 2;
    config.capture.shareMode = ma_share_mode_exclusive;
    if (inputDeviceIndex_ >= 0) {
        config.capture.pDeviceID = deviceIdByIndex(ma_device_type_capture, inputDeviceIndex_);
    }

    // Playback (speaker output)
    config.playback.format = ma_format_f32;
    config.playback.channels = 2;
    config.playback.shareMode = ma_share_mode_exclusive;
    if (outputDeviceIndex_ >= 0) {
        config.playback.pDeviceID = deviceIdByIndex(ma_device_type_playback, outputDeviceIndex_);
    }

    // Data callback
    config.dataCallback = [](ma_device* device, void* output, const void* input, ma_uint32 frameCount) {
        MiniaudioEngine* engine = static_cast<MiniaudioEngine*>(device->pUserData);
        if (engine) {
            engine->dataCallbackImpl(device, output, input, frameCount);
        }
    };
    config.pUserData = this;

    // device_ is a ma_device value (not pointer); &device_ gives ma_device*
    ma_result result = ma_device_init(nullptr, &config, &device_);
    if (result != MA_SUCCESS) {
        printf("MiniaudioEngine: ma_device_init failed: %d\n", result);
        return false;
    }

    printf("MiniaudioEngine: initialized (playback=%s, capture=%s, sr=%u, ch=%u)\n",
           device_.playback.name, device_.capture.name,
           device_.sampleRate, device_.playback.channels);
    return true;
}

void MiniaudioEngine::shutdown()
{
    stop();
    ma_device_uninit(&device_);
    printf("MiniaudioEngine: shutdown\n");
}

void MiniaudioEngine::setInputDevice(int index)
{
    inputDeviceIndex_ = index;
    bool wasRunning = running_.load();
    if (wasRunning) {
        stop();
        ma_device_uninit(&device_);
        initialize();
        start();
    }
}

void MiniaudioEngine::setOutputDevice(int index)
{
    outputDeviceIndex_ = index;
    bool wasRunning = running_.load();
    if (wasRunning) {
        stop();
        ma_device_uninit(&device_);
        initialize();
        start();
    }
}

void MiniaudioEngine::start()
{
    if (running_.load()) return;

    ma_result result = ma_device_start(&device_);
    if (result != MA_SUCCESS) {
        printf("MiniaudioEngine: ma_device_start failed: %d\n", result);
        return;
    }
    running_.store(true);
    printf("MiniaudioEngine: started\n");
}

void MiniaudioEngine::stop()
{
    if (!running_.load()) return;
    ma_device_stop(&device_);
    running_.store(false);
    printf("MiniaudioEngine: stopped\n");
}

bool MiniaudioEngine::isRunning() const
{
    return running_.load();
}

void MiniaudioEngine::setCallback(AudioEngineCallback* cb)
{
    std::lock_guard<std::mutex> lock(callbackMutex_);
    callback_ = cb;
}

void MiniaudioEngine::setVolume(float vol)
{
    volume_.store(vol);
}

void MiniaudioEngine::setAudioRouter(AudioRouter* router)
{
    audioRouter_ = router;
}

void MiniaudioEngine::dataCallbackImpl(ma_device*, void* output, const void* input, ma_uint32 frameCount)
{
    const float* in = static_cast<const float*>(input);
    float* out = static_cast<float*>(output);

    const int channels = 2;
    const int numSamples = static_cast<int>(frameCount);

    // ── Capture: send local mic audio to AudioRouter ───────────────
    if (in != nullptr) {
        // Compute RMS level for input metering
        float sumSq = 0.0f;
        for (int i = 0; i < numSamples * channels; ++i) {
            float s = in[i];
            sumSq += s * s;
        }
        float rms = std::sqrt(sumSq / static_cast<float>(numSamples * channels));
        float prev = inputLevel_.load(std::memory_order_relaxed);
        inputLevel_.store(prev + LEVEL_SMOOTHING * (rms - prev), std::memory_order_release);

        if (audioRouter_) {
            audioRouter_->onLocalAudioReady(in, numSamples, channels);
        }
    }

    // ── Playback: pull remote/mixed audio from AudioRouter ─────────
    if (audioRouter_ && out != nullptr) {
        float playbackBuffer[256 * 2]; // max bufferSize * channels
        bool hasPlayback = audioRouter_->getMixerPlayableSamples(
            playbackBuffer, numSamples * channels);
        if (hasPlayback) {
            float vol = volume_.load();
            for (int i = 0; i < numSamples * channels; ++i) {
                out[i] = std::fmax(-1.0f, std::fmin(1.0f, playbackBuffer[i] * vol));
            }
        } else {
            for (ma_uint32 i = 0; i < frameCount * channels; ++i)
                out[i] = 0.0f;
        }
    } else if (out != nullptr) {
        // Apply volume only (standalone mode)
        float vol = volume_.load();
        if (vol < 0.999f || vol > 1.001f) {
            for (ma_uint32 i = 0; i < frameCount * channels; ++i)
                out[i] *= vol;
        } else {
            for (ma_uint32 i = 0; i < frameCount * channels; ++i)
                out[i] = 0.0f; // no router: silence
        }
    }

    // Thread-safe access to legacy callback_
    AudioEngineCallback* cb = nullptr;
    {
        std::lock_guard<std::mutex> lock(callbackMutex_);
        cb = callback_;
    }
    if (cb && in != nullptr) {
        cb->audioReceived(in, numSamples, channels);
    }
}

const ma_device_id* MiniaudioEngine::deviceIdByIndex(ma_device_type type, int index)
{
    ma_context ctx;
    ma_result r = ma_context_init(nullptr, 0, nullptr, &ctx);
    if (r != MA_SUCCESS) return nullptr;

    ma_device_info* playbackInfos = nullptr;
    ma_device_info* captureInfos = nullptr;
    ma_uint32 playbackCount = 0;
    ma_uint32 captureCount = 0;

    r = ma_context_get_devices(&ctx, &playbackInfos, &playbackCount, &captureInfos, &captureCount);
    if (r != MA_SUCCESS) { ma_context_uninit(&ctx); return nullptr; }

    ma_device_info* infos = nullptr;
    ma_uint32 count = 0;
    if (type == ma_device_type_playback) { infos = playbackInfos; count = playbackCount; }
    else if (type == ma_device_type_capture) { infos = captureInfos; count = captureCount; }

    if (index < 0 || static_cast<ma_uint32>(index) >= count || infos == nullptr) {
        ma_context_uninit(&ctx);
        return nullptr;
    }

    static ma_device_id result;
    result = infos[index].id;
    ma_context_uninit(&ctx);
    return &result;
}
