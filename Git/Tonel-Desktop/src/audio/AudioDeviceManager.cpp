// AudioDeviceManager.cpp - Implementation
#include "AudioDeviceManager.h"

AudioDeviceManagerWrapper::AudioDeviceManagerWrapper()
{
    manager.addChangeListener(this);
    needsRefresh_ = true;
}

AudioDeviceManagerWrapper::~AudioDeviceManagerWrapper()
{
    manager.removeChangeListener(this);
}

void AudioDeviceManagerWrapper::scanDevices()
{
    inputDevices.clear();
    outputDevices.clear();

    auto& types = manager.getAvailableDeviceTypes();
    for (auto* type : types)
    {
        type->scanForDevices();
        auto inputs = type->getDeviceNames(true);   // input devices
        auto outputs = type->getDeviceNames(false);  // output devices

        for (const auto& name : inputs)
            inputDevices.addIfNotAlreadyThere(name);
        for (const auto& name : outputs)
            outputDevices.addIfNotAlreadyThere(name);
    }
}

juce::StringArray AudioDeviceManagerWrapper::getInputDevices()
{
    if (needsRefresh_) {
        scanDevices();
        needsRefresh_ = false;
    }
    return inputDevices;
}

juce::StringArray AudioDeviceManagerWrapper::getOutputDevices()
{
    if (needsRefresh_) {
        scanDevices();
        needsRefresh_ = false;
    }
    return outputDevices;
}

juce::String AudioDeviceManagerWrapper::getCurrentInputDeviceName() const
{
    auto setup = manager.getAudioDeviceSetup();
    return setup.inputDeviceName;
}

juce::String AudioDeviceManagerWrapper::getCurrentOutputDeviceName() const
{
    auto setup = manager.getAudioDeviceSetup();
    return setup.outputDeviceName;
}

bool AudioDeviceManagerWrapper::setInputDevice(const juce::String& name)
{
    if (name.isEmpty()) return false;

    auto setup = manager.getAudioDeviceSetup();
    setup.inputDeviceName = name;
    auto result = manager.setAudioDeviceSetup(setup, true);
    if (result.isNotEmpty())
    {
        juce::Logger::writeToLog("AudioDeviceManager: failed to set input device: " + result);
    }
    return result.isEmpty();
}

bool AudioDeviceManagerWrapper::setOutputDevice(const juce::String& name)
{
    if (name.isEmpty()) return false;

    auto setup = manager.getAudioDeviceSetup();
    setup.outputDeviceName = name;
    auto result = manager.setAudioDeviceSetup(setup, true);
    if (result.isNotEmpty())
    {
        juce::Logger::writeToLog("AudioDeviceManager: failed to set output device: " + result);
    }
    return result.isEmpty();
}

bool AudioDeviceManagerWrapper::setBufferSize(int size)
{
    auto setup = manager.getAudioDeviceSetup();
    setup.bufferSize = size;
    auto result = manager.setAudioDeviceSetup(setup, true);
    return result.isEmpty();
}

juce::StringArray AudioDeviceManagerWrapper::getBufferSizeOptions() const
{
    return {"64", "128", "256", "512"};
}

double AudioDeviceManagerWrapper::getSampleRate() const
{
    if (auto* device = manager.getCurrentAudioDevice())
        return device->getCurrentSampleRate();
    return 48000.0;
}

int AudioDeviceManagerWrapper::getBufferSize() const
{
    if (auto* device = manager.getCurrentAudioDevice())
        return device->getCurrentBufferSizeSamples();
    return 256;
}

void AudioDeviceManagerWrapper::addDeviceChangeListener(AudioDeviceManagerCallback* listener)
{
    listeners.add(listener);
}

void AudioDeviceManagerWrapper::removeDeviceChangeListener(AudioDeviceManagerCallback* listener)
{
    listeners.remove(listener);
}

void AudioDeviceManagerWrapper::changeListenerCallback(juce::ChangeBroadcaster* /*source*/)
{
    needsRefresh_ = true;
    listeners.call(&AudioDeviceManagerCallback::audioDevicesChanged);
}
