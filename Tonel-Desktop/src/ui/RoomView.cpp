// RoomView.cpp - Rehearsal room view implementation
#include "RoomView.h"
#include "audio/AudioEngine.h"
#include "audio/AudioDeviceManager.h"
#include <cmath>

// ParticipantCard implementation
ParticipantCard::ParticipantCard()
{
    addAndMakeVisible(nameLabel);
    nameLabel.setColour(juce::Label::textColourId, juce::Colours::white);
    nameLabel.setFont(juce::Font(16.0f, juce::Font::bold));
    
    addAndMakeVisible(statusLabel);
    statusLabel.setColour(juce::Label::textColourId, juce::Colour::fromRGB(136, 136, 136));
    statusLabel.setFont(juce::Font(14.0f, juce::Font::plain));
    
    addAndMakeVisible(volumeSlider);
    volumeSlider.setRange(0.0f, 1.0f);
    volumeSlider.setValue(0.8f);
}

void ParticipantCard::setParticipant(const Participant& p)
{
    participant = p;
    nameLabel.setText(p.name, juce::dontSendNotification);
    
    if (p.isMuted) {
        statusLabel.setText(juce::CharPointer_UTF8("已静音"), juce::dontSendNotification);
        statusLabel.setColour(juce::Label::textColourId, juce::Colour::fromRGB(255, 68, 68));
    } else if (p.isConnected) {
        statusLabel.setText(juce::CharPointer_UTF8("正在演奏"), juce::dontSendNotification);
        statusLabel.setColour(juce::Label::textColourId, juce::Colour::fromRGB(0, 255, 136));
    } else {
        statusLabel.setText(juce::CharPointer_UTF8("已离开"), juce::dontSendNotification);
        statusLabel.setColour(juce::Label::textColourId, juce::Colour::fromRGB(136, 136, 136));
    }
    
    volumeSlider.setValue(p.volume);
}

void ParticipantCard::paint(juce::Graphics& g)
{
    g.fillAll(juce::Colour::fromRGB(30, 30, 30));
    g.setColour(juce::Colour::fromRGB(50, 50, 50));
    g.drawRoundedRectangle(getLocalBounds().toFloat(), 8.0f, 1.0f);
}

void ParticipantCard::resized()
{
    int padding = 12;
    nameLabel.setBounds(padding, padding, getWidth() - padding * 2, 24);
    statusLabel.setBounds(padding, padding + 26, getWidth() - padding * 2, 20);
    volumeSlider.setBounds(padding, padding + 55, getWidth() - padding * 2, 24);
}

// RoomView implementation
RoomView::RoomView()
{
    addAndMakeVisible(roomCodeLabel);
    roomCodeLabel.setColour(juce::Label::textColourId, juce::Colours::white);
    roomCodeLabel.setFont(juce::Font(14.0f, juce::Font::plain));
    
    addAndMakeVisible(latencyLabel);
    latencyLabel.setColour(juce::Label::textColourId, juce::Colour::fromRGB(0, 212, 255));
    latencyLabel.setFont(juce::Font(14.0f, juce::Font::plain));
    
    addAndMakeVisible(connectionLabel);
    connectionLabel.setText(juce::CharPointer_UTF8("● 已连接"), juce::dontSendNotification);
    connectionLabel.setColour(juce::Label::textColourId, juce::Colour::fromRGB(0, 255, 136));
    
    addAndMakeVisible(leaveButton);
    leaveButton.setButtonText(juce::CharPointer_UTF8("离开房间"));
    leaveButton.setColour(juce::TextButton::buttonColourId, juce::Colour::fromRGB(255, 68, 68));
    leaveButton.onClick = [this] { if (callback) callback->onLeaveRoom(); };
    
    addAndMakeVisible(muteButton);
    muteButton.setButtonText(juce::CharPointer_UTF8("🎤 静音"));
    muteButton.onClick = [this] { if (callback) callback->onMuteToggle(); };

    addAndMakeVisible(settingsButton);
    settingsButton.setButtonText(juce::CharPointer_UTF8("⚙️"));
    settingsButton.setColour(juce::TextButton::buttonColourId, juce::Colour::fromRGB(60, 60, 60));
    settingsButton.onClick = [this] { if (callback) callback->onOpenSettings(); };

    addAndMakeVisible(inputDeviceBox);
    inputDeviceBox.onChange = [this]
    {
        if (!deviceManager_) return;
        auto inputs = deviceManager_->getInputDevices();
        int idx = inputDeviceBox.getSelectedItemIndex();
        if (idx >= 0 && idx < inputs.size()) {
            deviceManager_->setInputDevice(inputs[idx]);
        }
    };

    // FIX: refresh participant levels every 50ms so the UI stays responsive.
    startTimer(50);
    
    addAndMakeVisible(volumeSlider);
    volumeSlider.setRange(0.0f, 1.0f);
    volumeSlider.setValue(0.8f);
    volumeSlider.onValueChange = [this] { 
        if (callback) callback->onVolumeChange(volumeSlider.getValue()); 
    };

    // Audio input level meter label
    addAndMakeVisible(levelLabel);
    levelLabel.setText(juce::CharPointer_UTF8("输入电平"), juce::dontSendNotification);
    levelLabel.setColour(juce::Label::textColourId, juce::Colour::fromRGB(180, 180, 180));
    levelLabel.setFont(juce::Font(12.0f, juce::Font::plain));

    addAndMakeVisible(levelValueLabel);
    levelValueLabel.setText(juce::CharPointer_UTF8("--- dB"), juce::dontSendNotification);
    levelValueLabel.setColour(juce::Label::textColourId, juce::Colour::fromRGB(0, 255, 136));
    levelValueLabel.setFont(juce::Font(16.0f, juce::Font::plain));
}

void RoomView::setAppState(AppState* state)
{
    appState = state;
    updateParticipantCards();
    
    if (appState) {
        roomCodeLabel.setText(juce::String(juce::CharPointer_UTF8("房间号: ")) + appState->getRoomCode(), juce::dontSendNotification);
        latencyLabel.setText(juce::String(juce::CharPointer_UTF8("延迟: ")) + juce::String(appState->getLatency()) + juce::String(juce::CharPointer_UTF8("ms")), juce::dontSendNotification);
        // Update mute button label to reflect current mute state
        if (appState->isMyMuted()) {
            muteButton.setButtonText(juce::CharPointer_UTF8("🔇 静音中"));
        } else {
            muteButton.setButtonText(juce::CharPointer_UTF8("🎤 静音"));
        }
    }
}

void RoomView::updateParticipantCards()
{
    // Remove old cards
    participantCards.clear();
    
    if (!appState) return;
    
    // Create cards for each participant
    for (const auto& p : appState->getParticipants())
    {
        auto card = std::make_unique<ParticipantCard>();
        card->setParticipant(p);
        addAndMakeVisible(card.get());
        participantCards.push_back(std::move(card));
    }
}

void RoomView::paint(juce::Graphics& g)
{
    g.fillAll(juce::Colour::fromRGB(19, 18, 18));
    
    // Top bar background
    g.setColour(juce::Colour::fromRGB(25, 25, 25));
    g.fillRect(0, 0, getWidth(), 60);

    // ── Audio input level meter (bottom-left) ─────────────────────────
    // Level bar: 200px wide, 8px tall, drawn just above the bottom controls
    int meterX = 20;
    int meterY = getHeight() - 120;  // just above bottomY
    int meterW = 200;
    int meterH = 8;

    // Background track
    g.setColour(juce::Colour::fromRGB(60, 60, 60));
    g.fillRoundedRectangle(juce::Rectangle<float>(meterX, meterY, meterW, meterH), 4.0f);

    // Filled portion (green → yellow → red based on level)
    float level = currentInputLevel_;  // 0.0–1.0
    int fillW = static_cast<int>(meterW * juce::jlimit(0.0f, 1.0f, level));
    if (fillW > 0) {
        // Colour: green (0–60%), yellow (60–85%), red (85–100%)
        juce::Colour barColour;
        if (level < 0.6f) {
            barColour = juce::Colour::fromRGB(0, 220, 80);
        } else if (level < 0.85f) {
            barColour = juce::Colour::fromRGB(255, 200, 0);
        } else {
            barColour = juce::Colour::fromRGB(255, 60, 60);
        }
        g.setColour(barColour);
        g.fillRoundedRectangle(juce::Rectangle<float>(meterX, meterY, static_cast<float>(fillW), meterH), 4.0f);
    }

    // Level text (dB approximation: -60dB to 0dB)
    int dbLevel = (level > 0.001f) ? static_cast<int>(20.0f * std::log10(level)) : -60;
    juce::String levelText = juce::String(dbLevel) + juce::String(juce::CharPointer_UTF8(" dB"));
    g.setColour(juce::Colour::fromRGB(180, 180, 180));
    g.setFont(juce::Font(11.0f, juce::Font::plain));
    g.drawText(levelText, meterX, meterY - 16, 80, 14, juce::Justification::left);
}

void RoomView::resized()
{
    int padding = 20;
    
    // Top bar
    roomCodeLabel.setBounds(padding, 20, 150, 20);
    latencyLabel.setBounds(180, 20, 100, 20);
    connectionLabel.setBounds(300, 20, 100, 20);
    settingsButton.setBounds(getWidth() - 160 - padding, 15, 40, 30);
    inputDeviceBox.setBounds(getWidth() - 380 - padding, 15, 210, 30);
    leaveButton.setBounds(getWidth() - 100 - padding, 15, 100, 30);
    
    // Participant cards grid
    int cardWidth = 160;
    int cardHeight = 120;
    int cardPadding = 15;
    int cardsPerRow = (getWidth() - padding * 2) / (cardWidth + cardPadding);
    int startY = 80;
    
    int idx = 0;
    for (auto& card : participantCards)
    {
        int row = idx / cardsPerRow;
        int col = idx % cardsPerRow;
        int x = padding + col * (cardWidth + cardPadding);
        int y = startY + row * (cardHeight + cardPadding);
        card->setBounds(x, y, cardWidth, cardHeight);
        idx++;
    }
    
    // Bottom controls
    int bottomY = getHeight() - 100;
    muteButton.setBounds(padding, bottomY, 100, 40);
    
    int sliderX = padding + 120;
    int sliderW = getWidth() - sliderX - padding;
    volumeSlider.setBounds(sliderX, bottomY + 10, sliderW - 200, 20);

    // Level meter label (above the meter bar)
    levelLabel.setBounds(padding, getHeight() - 135, 200, 14);
    levelValueLabel.setBounds(padding + 210, getHeight() - 140, 100, 24);
}

void RoomView::refreshInputDevices()
{
    if (!deviceManager_) return;
    auto inputs = deviceManager_->getInputDevices();
    inputDeviceBox.clear();
    if (inputs.isEmpty()) {
        inputDeviceBox.addItem(juce::CharPointer_UTF8("无可用设备"), 1);
        inputDeviceBox.setSelectedItemIndex(0);
        inputDeviceBox.setEnabled(false);
    } else {
        inputDeviceBox.setEnabled(true);
        for (int i = 0; i < inputs.size(); ++i)
            inputDeviceBox.addItem(inputs[i], i + 1);
        auto current = deviceManager_->getCurrentInputDeviceName();
        auto idx = inputs.indexOf(current);
        inputDeviceBox.setSelectedItemIndex(idx >= 0 ? idx : 0);
    }
}

void RoomView::timerCallback()
{
    // Refresh input device list every 2 seconds (timer fires every 50ms)
    static int tick = 0;
    if (tick++ % 40 == 0)  // ~2 seconds
        refreshInputDevices();

    // Poll audio input level from engine and update AppState for App-level access
    if (audioEngine_) {
        float lvl = audioEngine_->getInputLevel();
        if (appState)
            appState->setInputLevel(lvl);
        currentInputLevel_ = lvl;
        int db = (lvl > 0.001f) ? static_cast<int>(20.0f * std::log10(lvl)) : -60;
        levelValueLabel.setText(juce::String(db) + juce::String(juce::CharPointer_UTF8(" dB")),
                                juce::dontSendNotification);
    }
    // Lightweight refresh — JUCE only redraws dirty regions.
    repaint();
}
