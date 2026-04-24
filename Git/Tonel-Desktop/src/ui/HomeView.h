// HomeView.h - Home screen with create/join room buttons
#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

class HomeViewCallback
{
public:
    virtual ~HomeViewCallback() = default;
    virtual void onCreateRoom() = 0;
    virtual void onJoinRoom() = 0;
    virtual void onSettings() = 0;
};

class HomeView : public juce::Component
{
public:
    HomeView();
    
    void setCallback(HomeViewCallback* cb) { callback = cb; }
    
    void paint(juce::Graphics& g) override;
    void resized() override;
    
private:
    HomeViewCallback* callback = nullptr;
    
    juce::TextButton createRoomButton{juce::CharPointer_UTF8("创建房间")};
    juce::TextButton joinRoomButton{juce::CharPointer_UTF8("加入房间")};
    juce::TextButton settingsButton{juce::CharPointer_UTF8("设置")};
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(HomeView)
};
