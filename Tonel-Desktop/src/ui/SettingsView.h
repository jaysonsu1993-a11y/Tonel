// SettingsView.h - Settings panel with audio device selection
#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include "../audio/AudioDeviceManager.h"

class SettingsViewCallback
{
public:
    virtual ~SettingsViewCallback() = default;
    virtual void onSettingsClosed() = 0;
};

class SettingsView : public juce::Component,
                     private AudioDeviceManagerCallback
{
public:
    explicit SettingsView(AudioDeviceManagerWrapper& deviceManager);
    ~SettingsView();

    void setCallback(SettingsViewCallback* cb) { callback = cb; }

    void paint(juce::Graphics& g) override;
    void resized() override;

private:
    void refreshDeviceLists();
    void audioDevicesChanged() override;

    AudioDeviceManagerWrapper& deviceManager;
    SettingsViewCallback* callback = nullptr;

    // Header
    juce::Label titleLabel{"", juce::CharPointer_UTF8("音频设置")};

    // Input device
    juce::Label inputLabel{"", juce::CharPointer_UTF8("输入设备 (麦克风)")};
    juce::ComboBox inputDeviceBox;

    // Output device
    juce::Label outputLabel{"", juce::CharPointer_UTF8("输出设备 (扬声器/耳机)")};
    juce::ComboBox outputDeviceBox;

    // Buffer size
    juce::Label bufferLabel{"", "Buffer Size"};
    juce::ComboBox bufferSizeBox;

    // Sample rate
    juce::Label sampleRateLabel{"", ""};

    // Close button
    juce::TextButton closeButton{juce::CharPointer_UTF8("返回")};

    int currentSampleRate = 48000;
    int currentBufferSize = 256;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SettingsView)
};
