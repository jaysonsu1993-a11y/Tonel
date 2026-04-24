// MiniaudioEngine.h - Tonel-mini audio engine using miniaudio
#pragma once

#include "AudioEngine.h"
#include <miniaudio/miniaudio.h>
#include <atomic>
#include <mutex>

class AudioRouter;

class MiniaudioEngine : public AudioEngine
{
public:
    MiniaudioEngine();
    ~MiniaudioEngine() override;

    // AudioEngine interface — implement using miniaudio
    bool initialize() override;
    void shutdown() override;
    void setInputDevice(int index) override;
    void setOutputDevice(int index) override;
    void start() override;
    void stop() override;
    bool isRunning() const override;
    void setCallback(AudioEngineCallback* cb) override;
    int getSampleRate() const override { return 48000; }
    int getBufferSize() const override { return 256; }

    // Real-time audio level (RMS, smoothed, 0.0–1.0)
    float getInputLevel() const { return inputLevel_.load(std::memory_order_acquire); }

    // Miniaudio-specific
    void setVolume(float vol);
    float getVolume() const { return volume_.load(); }

    // Set AudioRouter for network audio routing
    void setAudioRouter(AudioRouter* router);

private:
    void dataCallbackImpl(ma_device* device, void* output, const void* input, ma_uint32 frameCount);

    ma_device device_;                              // miniaudio device (value, not pointer)
    std::mutex callbackMutex_;
    AudioEngineCallback* callback_ = nullptr;
    std::atomic<float> volume_{1.0f};
    std::atomic<bool> running_{false};
    int inputDeviceIndex_ = -1;
    int outputDeviceIndex_ = -1;
    AudioRouter* audioRouter_ = nullptr;

    // Input level metering (atomic for thread-safe reads from UI thread)
    static constexpr float LEVEL_SMOOTHING = 0.2f;  // 20% new / 80% hold
    std::atomic<float> inputLevel_{ 0.0f };

    // Helper: resolve device index to ma_device_id* (caller-owned pointer, do NOT delete)
    const ma_device_id* deviceIdByIndex(ma_device_type type, int index);
};
