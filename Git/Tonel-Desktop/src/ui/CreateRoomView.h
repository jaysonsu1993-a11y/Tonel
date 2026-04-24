// CreateRoomView.h - Create room dialog view
#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

class CreateRoomViewCallback {
public:
    virtual ~CreateRoomViewCallback() = default;
    virtual void onCreateRoomConfirmed(const juce::String& roomCode, const juce::String& password) = 0;
    virtual void onCreateRoomCancelled() = 0;
};

class CreateRoomView : public juce::Component {
public:
    CreateRoomView();

    void setCallback(CreateRoomViewCallback* cb) { callback = cb; }

    void paint(juce::Graphics& g) override;
    void resized() override;
    void mouseDown(const juce::MouseEvent& e) override;

private:
    CreateRoomViewCallback* callback = nullptr;

    juce::Label titleLabel_;
    juce::Label roomCodeLabel_;
    juce::TextEditor roomCodeEditor_;
    juce::Label passwordLabel_;
    juce::TextEditor passwordEditor_;
    juce::TextButton confirmButton_;
    juce::TextButton cancelButton_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(CreateRoomView)
};
