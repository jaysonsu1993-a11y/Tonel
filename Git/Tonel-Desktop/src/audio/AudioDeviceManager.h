// AudioDeviceManager.h - Audio device enumeration and selection using JUCE
#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_core/juce_core.h>

class AudioDeviceManagerCallback
{
public:
    virtual ~AudioDeviceManagerCallback() = default;
    virtual void audioDevicesChanged() = 0;
};

class AudioDeviceManagerWrapper : private juce::ChangeListener
{
public:
    AudioDeviceManagerWrapper();
    ~AudioDeviceManagerWrapper();

    // Device lists
    void scanDevices();
    juce::StringArray getInputDevices();
    juce::StringArray getOutputDevices();

    // Current device names
    juce::String getCurrentInputDeviceName() const;
    juce::String getCurrentOutputDeviceName() const;

    // Select devices by name
    bool setInputDevice(const juce::String& name);
    bool setOutputDevice(const juce::String& name);

    // Set buffer size
    bool setBufferSize(int size);

    // Buffer size options
    juce::StringArray getBufferSizeOptions() const;

    // Current audio settings
    double getSampleRate() const;
    int getBufferSize() const;

    // Listeners
    void addDeviceChangeListener(AudioDeviceManagerCallback* listener);
    void removeDeviceChangeListener(AudioDeviceManagerCallback* listener);

    // JUCE manager access for AudioEngine
    juce::AudioDeviceManager& getManager() { return manager; }

private:
    void changeListenerCallback(juce::ChangeBroadcaster* source) override;

    juce::AudioDeviceManager manager;
    juce::StringArray inputDevices;
    juce::StringArray outputDevices;
    juce::ListenerList<AudioDeviceManagerCallback> listeners;
    bool needsRefresh_ = true;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioDeviceManagerWrapper)
};
