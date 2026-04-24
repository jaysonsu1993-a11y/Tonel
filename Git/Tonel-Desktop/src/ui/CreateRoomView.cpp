// CreateRoomView.cpp - Create room dialog view implementation
#include "CreateRoomView.h"

CreateRoomView::CreateRoomView()
{

    titleLabel_.setText(juce::CharPointer_UTF8("创建房间"), juce::dontSendNotification);
    titleLabel_.setColour(juce::Label::textColourId, juce::Colours::white);
    titleLabel_.setFont(juce::Font(20.0f, juce::Font::bold));
    addAndMakeVisible(titleLabel_);

    roomCodeLabel_.setText(juce::CharPointer_UTF8("房间号:"), juce::dontSendNotification);
    roomCodeLabel_.setColour(juce::Label::textColourId, juce::Colours::white);
    addAndMakeVisible(roomCodeLabel_);

    roomCodeEditor_.setText(juce::String());
    roomCodeEditor_.setFont(juce::Font(16.0f));
    roomCodeEditor_.setColour(juce::TextEditor::backgroundColourId, juce::Colour::fromRGB(60, 60, 60));
    roomCodeEditor_.setColour(juce::TextEditor::textColourId, juce::Colours::white);
    roomCodeEditor_.setColour(juce::TextEditor::outlineColourId, juce::Colour::fromRGB(100, 100, 100));
    roomCodeEditor_.setBorder(juce::BorderSize<int>(2));
    roomCodeEditor_.setEscapeAndReturnKeysConsumed(false);
    addAndMakeVisible(roomCodeEditor_);

    passwordLabel_.setText(juce::CharPointer_UTF8("密码（可选）:"), juce::dontSendNotification);
    passwordLabel_.setColour(juce::Label::textColourId, juce::Colours::white);
    addAndMakeVisible(passwordLabel_);

    passwordEditor_.setText(juce::String());
    passwordEditor_.setFont(juce::Font(16.0f));
    passwordEditor_.setColour(juce::TextEditor::backgroundColourId, juce::Colour::fromRGB(60, 60, 60));
    passwordEditor_.setColour(juce::TextEditor::textColourId, juce::Colours::white);
    passwordEditor_.setColour(juce::TextEditor::outlineColourId, juce::Colour::fromRGB(100, 100, 100));
    passwordEditor_.setBorder(juce::BorderSize<int>(2));
    passwordEditor_.setEscapeAndReturnKeysConsumed(false);
    passwordEditor_.setPasswordCharacter(juce::CharPointer_UTF8("●")[0]);
    addAndMakeVisible(passwordEditor_);

    confirmButton_.setButtonText(juce::CharPointer_UTF8("创建"));
    confirmButton_.onClick = [this] {
        if (callback) {
            callback->onCreateRoomConfirmed(
                roomCodeEditor_.getText(),
                passwordEditor_.getText());
        }
    };
    addAndMakeVisible(confirmButton_);

    cancelButton_.setButtonText(juce::CharPointer_UTF8("取消"));
    cancelButton_.onClick = [this] {
        if (callback) callback->onCreateRoomCancelled();
    };
    addAndMakeVisible(cancelButton_);
}

void CreateRoomView::paint(juce::Graphics& g)
{
    g.fillAll(juce::Colour::fromRGB(30, 30, 30));
    g.setColour(juce::Colour::fromRGB(50, 50, 50));
    g.drawRoundedRectangle(getLocalBounds().toFloat(), 8.0f, 1.0f);
}

void CreateRoomView::mouseDown(const juce::MouseEvent& e)
{
    // Forward mouse clicks to the appropriate TextEditor
    if (roomCodeEditor_.getBounds().contains(e.getPosition())) {
        roomCodeEditor_.grabKeyboardFocus();
    } else if (passwordEditor_.getBounds().contains(e.getPosition())) {
        passwordEditor_.grabKeyboardFocus();
    }
}

void CreateRoomView::resized()
{
    int w = 340, h = 260;
    setSize(w, h);
    int px = 20, py = 20;

    titleLabel_.setBounds(px, py, w - px * 2, 30);
    py += 40;

    roomCodeLabel_.setBounds(px, py, 110, 24);
    roomCodeEditor_.setBounds(px + 115, py, w - px * 2 - 115, 28);
    py += 40;

    passwordLabel_.setBounds(px, py, 110, 24);
    passwordEditor_.setBounds(px + 115, py, w - px * 2 - 115, 28);
    py += 50;

    confirmButton_.setBounds(px, py, 130, 36);
    cancelButton_.setBounds(w - px - 130, py, 130, 36);
}
