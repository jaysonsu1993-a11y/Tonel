// RoomView.h - Rehearsal room view
#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include "AppState.h"

// Forward-declare AudioEngine (avoid circular include)
class AudioEngine;

class RoomViewCallback
{
public:
    virtual ~RoomViewCallback() = default;
    virtual void onLeaveRoom() = 0;
    virtual void onMuteToggle() = 0;
    virtual void onVolumeChange(float volume) = 0;
    virtual void onOpenSettings() = 0;
};

class ParticipantCard : public juce::Component
{
public:
    ParticipantCard();
    void setParticipant(const Participant& p);
    void paint(juce::Graphics& g) override;
    void resized() override;

private:
    Participant participant;
    juce::Label nameLabel{"", ""};
    juce::Label statusLabel{"", ""};
    juce::Slider volumeSlider{juce::Slider::LinearHorizontal, juce::Slider::NoTextBox};
};

class RoomView : public juce::Component, private juce::Timer
{
public:
    RoomView();

    void setCallback(RoomViewCallback* cb) { callback = cb; }
    void setAppState(AppState* state);
    void setAudioEngine(AudioEngine* eng) { audioEngine_ = eng; }
    void setAudioDeviceManager(class AudioDeviceManagerWrapper* dm) { deviceManager_ = dm; }

    void paint(juce::Graphics& g) override;
    void resized() override;
    void timerCallback() override;

private:
    RoomViewCallback* callback = nullptr;
    AppState* appState = nullptr;

    juce::Label roomCodeLabel{"", ""};
    juce::Label latencyLabel{"", ""};
    juce::Label connectionLabel{"", ""};
    juce::TextButton leaveButton{juce::CharPointer_UTF8("离开房间")};
    juce::TextButton muteButton{juce::CharPointer_UTF8("🎤 静音")};
    juce::TextButton settingsButton{juce::CharPointer_UTF8("⚙️")};
    juce::ComboBox inputDeviceBox;
    AudioEngine* audioEngine_ = nullptr;
    class AudioDeviceManagerWrapper* deviceManager_ = nullptr;

    void refreshInputDevices();
    juce::Slider volumeSlider{juce::Slider::LinearHorizontal, juce::Slider::NoTextBox};
    juce::Label levelLabel{"", ""};
    juce::Label levelValueLabel{"", ""};
    float currentInputLevel_ = 0.0f;  // latest polled input level (0.0–1.0)

    std::vector<std::unique_ptr<ParticipantCard>> participantCards;
    void updateParticipantCards();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(RoomView)
};
