// AudioEngine.h - Abstract audio engine interface
#pragma once

// Forward declare AudioDeviceManagerWrapper to avoid circular dependency
class AudioDeviceManagerWrapper;

class AudioEngineCallback
{
public:
    virtual ~AudioEngineCallback() = default;
    virtual void audioReceived(const float* buffer, int numSamples, int numChannels) = 0;
};

// Abstract interface for audio engines (JUCE + miniaudio implementations)
class AudioEngine
{
public:
    virtual ~AudioEngine() = default;

    // Lifecycle
    virtual bool initialize() = 0;
    virtual void shutdown() = 0;

    // Device selection
    virtual void setInputDevice(int index) = 0;
    virtual void setOutputDevice(int index) = 0;

    // Stream control
    virtual void start() = 0;
    virtual void stop() = 0;
    virtual bool isRunning() const = 0;

    // Callback registration
    virtual void setCallback(AudioEngineCallback* cb) = 0;

    // Info
    virtual int getSampleRate() const = 0;
    virtual int getBufferSize() const = 0;

    // Audio input level (for level meter display)
    virtual float getInputLevel() const = 0;
};
