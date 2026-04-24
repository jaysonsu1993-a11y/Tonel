// HomeView.cpp - Home screen implementation
#include "HomeView.h"

HomeView::HomeView()
{
    // Title
    addAndMakeVisible(createRoomButton);
    createRoomButton.setButtonText(juce::CharPointer_UTF8("创建房间"));
    createRoomButton.onClick = [this] { if (callback) callback->onCreateRoom(); };
    
    addAndMakeVisible(joinRoomButton);
    joinRoomButton.setButtonText(juce::CharPointer_UTF8("加入房间"));
    joinRoomButton.onClick = [this] { if (callback) callback->onJoinRoom(); };
    
    addAndMakeVisible(settingsButton);
    settingsButton.setButtonText(juce::CharPointer_UTF8("设置"));
    settingsButton.onClick = [this] { if (callback) callback->onSettings(); };
}

void HomeView::paint(juce::Graphics& g)
{
    // Dark background
    g.fillAll(juce::Colour::fromRGB(19, 18, 18));
    
    // Title - use default font which supports all languages
    g.setColour(juce::Colours::white);
    g.setFont(juce::Font(32.0f, juce::Font::bold));
    g.drawText("BandRehearsal", getWidth() / 2 - 100, 80, 200, 50, juce::Justification::centred);
    
    // Subtitle
    g.setFont(juce::Font(16.0f, juce::Font::plain));
    g.setColour(juce::Colour::fromRGB(136, 136, 136));
    g.drawText(juce::CharPointer_UTF8("乐队在线排练平台"), getWidth() / 2 - 50, 130, 100, 30, juce::Justification::centred);
}

void HomeView::resized()
{
    int buttonWidth = 200;
    int buttonHeight = 50;
    int x = (getWidth() - buttonWidth) / 2;
    
    createRoomButton.setBounds(x, 200, buttonWidth, buttonHeight);
    joinRoomButton.setBounds(x, 270, buttonWidth, buttonHeight);
    settingsButton.setBounds(x, 340, buttonWidth, buttonHeight);
}
