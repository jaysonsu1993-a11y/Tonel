// SettingsView.cpp - Settings panel implementation
#include "SettingsView.h"

namespace Colours
{
    const juce::Colour background { juce::Colour::fromRGB(19, 18, 18) };
    const juce::Colour panel { juce::Colour::fromRGB(30, 30, 30) };
    const juce::Colour panelBorder { juce::Colour::fromRGB(50, 50, 50) };
    const juce::Colour textPrimary { juce::Colour::fromRGB(255, 255, 255) };
    const juce::Colour textSecondary { juce::Colour::fromRGB(136, 136, 136) };
    const juce::Colour accent { juce::Colour::fromRGB(0, 212, 255) };
    const juce::Colour buttonBg { juce::Colour::fromRGB(45, 45, 45) };
    const juce::Colour buttonHover { juce::Colour::fromRGB(60, 60, 60) };
}

SettingsView::SettingsView(AudioDeviceManagerWrapper& dm)
    : deviceManager(dm)
{
    deviceManager.addDeviceChangeListener(this);

    // Title
    addAndMakeVisible(titleLabel);
    titleLabel.setFont(juce::Font(22.0f, juce::Font::bold));
    titleLabel.setColour(juce::Label::textColourId, Colours::textPrimary);

    // Input device section
    addAndMakeVisible(inputLabel);
    inputLabel.setFont(juce::Font(14.0f, juce::Font::plain));
    inputLabel.setColour(juce::Label::textColourId, Colours::textSecondary);

    addAndMakeVisible(inputDeviceBox);
    inputDeviceBox.addItem(juce::String(juce::CharPointer_UTF8("扫描中...")), 1);
    inputDeviceBox.setSelectedItemIndex(0);
    inputDeviceBox.onChange = [this]
    {
        auto name = inputDeviceBox.getText();
        if (name.isNotEmpty() && name != "无可用设备" && name != "扫描中...")
        {
            deviceManager.setInputDevice(name);
        }
    };

    // Output device section
    addAndMakeVisible(outputLabel);
    outputLabel.setFont(juce::Font(14.0f, juce::Font::plain));
    outputLabel.setColour(juce::Label::textColourId, Colours::textSecondary);

    addAndMakeVisible(outputDeviceBox);
    outputDeviceBox.addItem(juce::String(juce::CharPointer_UTF8("扫描中...")), 1);
    outputDeviceBox.setSelectedItemIndex(0);
    outputDeviceBox.onChange = [this]
    {
        auto name = outputDeviceBox.getText();
        if (name.isNotEmpty() && name != "无可用设备" && name != "扫描中...")
        {
            deviceManager.setOutputDevice(name);
        }
    };

    // Buffer size section
    addAndMakeVisible(bufferLabel);
    bufferLabel.setFont(juce::Font(14.0f, juce::Font::plain));
    bufferLabel.setColour(juce::Label::textColourId, Colours::textSecondary);

    addAndMakeVisible(bufferSizeBox);
    auto bufferSizes = deviceManager.getBufferSizeOptions();
    for (int i = 0; i < bufferSizes.size(); ++i)
    {
        bufferSizeBox.addItem(bufferSizes[i] + " samples", i + 1);
    }
    bufferSizeBox.setSelectedItemIndex(2); // default 256
    bufferSizeBox.onChange = [this]
    {
        auto items = deviceManager.getBufferSizeOptions();
        int idx = bufferSizeBox.getSelectedItemIndex();
        if (idx >= 0 && idx < items.size())
        {
            deviceManager.setBufferSize(items[idx].getIntValue());
        }
    };

    // Sample rate display
    addAndMakeVisible(sampleRateLabel);
    sampleRateLabel.setFont(juce::Font(13.0f, juce::Font::plain));
    sampleRateLabel.setColour(juce::Label::textColourId, Colours::accent);

    // Close button
    addAndMakeVisible(closeButton);
    closeButton.setButtonText(juce::CharPointer_UTF8("返回"));
    closeButton.onClick = [this] { if (callback) callback->onSettingsClosed(); };

    refreshDeviceLists();

    // Update sample rate display
    currentSampleRate = (int)deviceManager.getSampleRate();
    currentBufferSize = deviceManager.getBufferSize();
    sampleRateLabel.setText(
        juce::String(juce::CharPointer_UTF8("采样率: ")) + juce::String(currentSampleRate) + juce::String(juce::CharPointer_UTF8(" Hz  |  "))
        + juce::String(juce::CharPointer_UTF8("Buffer: ")) + juce::String(currentBufferSize) + juce::String(juce::CharPointer_UTF8(" samples")),
        juce::dontSendNotification);
}

SettingsView::~SettingsView()
{
    deviceManager.removeDeviceChangeListener(this);
}

void SettingsView::refreshDeviceLists()
{
    auto inputs = deviceManager.getInputDevices();
    auto outputs = deviceManager.getOutputDevices();

    // Rebuild input device list
    inputDeviceBox.clear();
    if (inputs.isEmpty())
    {
        inputDeviceBox.addItem(juce::String(juce::CharPointer_UTF8("无可用设备")), 1);
        inputDeviceBox.setSelectedItemIndex(0);
        inputDeviceBox.setEnabled(false);
    }
    else
    {
        inputDeviceBox.setEnabled(true);
        for (int i = 0; i < inputs.size(); ++i)
            inputDeviceBox.addItem(inputs[i], i + 1);
        // Select current
        auto current = deviceManager.getCurrentInputDeviceName();
        auto idx = inputs.indexOf(current);
        if (idx >= 0)
            inputDeviceBox.setSelectedItemIndex(idx);
        else
            inputDeviceBox.setSelectedItemIndex(0);
    }

    // Rebuild output device list
    outputDeviceBox.clear();
    if (outputs.isEmpty())
    {
        outputDeviceBox.addItem(juce::String(juce::CharPointer_UTF8("无可用设备")), 1);
        outputDeviceBox.setSelectedItemIndex(0);
        outputDeviceBox.setEnabled(false);
    }
    else
    {
        outputDeviceBox.setEnabled(true);
        for (int i = 0; i < outputs.size(); ++i)
            outputDeviceBox.addItem(outputs[i], i + 1);
        auto current = deviceManager.getCurrentOutputDeviceName();
        auto idx = outputs.indexOf(current);
        if (idx >= 0)
            outputDeviceBox.setSelectedItemIndex(idx);
        else
            outputDeviceBox.setSelectedItemIndex(0);
    }

    // Update sample rate
    currentSampleRate = (int)deviceManager.getSampleRate();
    currentBufferSize = deviceManager.getBufferSize();
    sampleRateLabel.setText(
        juce::String(juce::CharPointer_UTF8("采样率: ")) + juce::String(currentSampleRate) + juce::String(juce::CharPointer_UTF8(" Hz  |  "))
        + juce::String(juce::CharPointer_UTF8("Buffer: ")) + juce::String(currentBufferSize) + juce::String(juce::CharPointer_UTF8(" samples")),
        juce::dontSendNotification);
}

void SettingsView::audioDevicesChanged()
{
    juce::MessageManager::callAsync([this] { refreshDeviceLists(); });
}

void SettingsView::paint(juce::Graphics& g)
{
    g.fillAll(Colours::background);

    // Title area
    g.setColour(Colours::panel);
    g.fillRect(0, 0, getWidth(), 60);

    // Separator under title
    g.setColour(Colours::panelBorder);
    g.drawRect(0, 60, getWidth(), 1);

    // Panel background for each section
    auto bounds = getLocalBounds();
    g.setColour(Colours::panel);
}

void SettingsView::resized()
{
    int margin = 20;
    int sectionGap = 28;
    int labelH = 20;
    int comboH = 36;
    int controlWidth = getWidth() - margin * 2;

    // Title
    titleLabel.setBounds(margin, 18, 200, 28);

    // Input section
    int y = 80;
    inputLabel.setBounds(margin, y, controlWidth, labelH);
    y += labelH + 6;
    inputDeviceBox.setBounds(margin, y, controlWidth, comboH);

    // Output section
    y += comboH + sectionGap;
    outputLabel.setBounds(margin, y, controlWidth, labelH);
    y += labelH + 6;
    outputDeviceBox.setBounds(margin, y, controlWidth, comboH);

    // Buffer size section
    y += comboH + sectionGap;
    bufferLabel.setBounds(margin, y, 120, labelH);
    bufferSizeBox.setBounds(margin + 130, y, 150, comboH);

    // Sample rate info
    y += comboH + 12;
    sampleRateLabel.setBounds(margin, y, controlWidth, labelH);

    // Close button
    int buttonW = 100;
    closeButton.setBounds(getWidth() - buttonW - margin, getHeight() - 50, buttonW, 36);
}
