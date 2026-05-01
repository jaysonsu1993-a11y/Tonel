// JuceAudioEngine.h - JUCE-based audio engine implementation
#pragma once

#include "AudioEngine.h"
#include <juce_audio_devices/juce_audio_devices.h>

// Forward declare AudioDeviceManagerWrapper to avoid circular dependency
class AudioDeviceManagerWrapper;
class AudioRouter;

// JUCE implementation of AudioEngine interface.
// Uses the shared JUCE AudioDeviceManager for device management.
class JuceAudioEngine : public AudioEngine,
                        public juce::AudioIODeviceCallback,
                        private juce::ChangeListener
{
public:
    explicit JuceAudioEngine(AudioDeviceManagerWrapper& wrapper);
    ~JuceAudioEngine() override;

    // AudioEngine interface
    bool initialize() override;
    void shutdown() override;
    void setInputDevice(int index) override;
    void setOutputDevice(int index) override;
    void start() override;
    void stop() override;
    bool isRunning() const override;
    void setCallback(AudioEngineCallback* cb) override;
    int getSampleRate() const override { return static_cast<int>(currentSampleRate_); }
    int getBufferSize() const override { return currentBufferSize_; }

    // Real-time audio level (RMS, smoothed, 0.0–1.0)
    float getInputLevel() const override { return inputLevel_.load(std::memory_order_acquire); }

    // Set AudioRouter for network audio routing
    void setAudioRouter(AudioRouter* router);

    // Legacy API (still used by main.cpp)
    void startAudio() { start(); }
    void stopAudio() { stop(); }

private:
    // juce::AudioIODeviceCallback
    void audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                          int totalNumInputChannels,
                                          float* const* outputChannelData,
                                          int totalNumOutputChannels,
                                          int numSamples,
                                          const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceAboutToStart(juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;

    // juce::ChangeListener
    void changeListenerCallback(juce::ChangeBroadcaster* source) override;

    void restartAudio();

    AudioDeviceManagerWrapper& wrapper_;
    juce::AudioDeviceManager& manager_;
    AudioEngineCallback* callback_ = nullptr;
    double currentSampleRate_ = 48000.0;
    int currentBufferSize_ = 256;
    int numChannels_ = 2;
    bool running_ = false;

    juce::AudioBuffer<float> inputBuffer_;
    juce::AudioBuffer<float> outputBuffer_;
    AudioRouter* audioRouter_ = nullptr;

    // Input level metering (atomic for thread-safe reads from UI thread)
    static constexpr float LEVEL_SMOOTHING = 0.2f;  // 20% new / 80% hold
    std::atomic<float> inputLevel_{ 0.0f };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(JuceAudioEngine)
};
