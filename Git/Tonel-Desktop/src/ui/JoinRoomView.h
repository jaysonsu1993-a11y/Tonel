// JoinRoomView.h - Join room dialog view
#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

class JoinRoomViewCallback {
public:
    virtual ~JoinRoomViewCallback() = default;
    virtual void onJoinRoomConfirmed(const juce::String& roomCode, const juce::String& password) = 0;
    virtual void onJoinRoomCancelled() = 0;
};

class JoinRoomView : public juce::Component {
public:
    JoinRoomView();

    void setCallback(JoinRoomViewCallback* cb) { callback = cb; }

    void paint(juce::Graphics& g) override;
    void resized() override;
    void mouseDown(const juce::MouseEvent& e) override;

private:
    JoinRoomViewCallback* callback = nullptr;

    juce::Label titleLabel_;
    juce::Label roomCodeLabel_;
    juce::TextEditor roomCodeEditor_;
    juce::Label passwordLabel_;
    juce::TextEditor passwordEditor_;
    juce::TextButton confirmButton_;
    juce::TextButton cancelButton_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(JoinRoomView)
};
