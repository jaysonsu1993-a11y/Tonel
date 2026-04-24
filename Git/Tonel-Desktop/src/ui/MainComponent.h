// MainComponent.h - Main window for BandRehearsal
#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include <juce_gui_extra/juce_gui_extra.h>

class AppState;

class MainComponent : public juce::Component
{
public:
    MainComponent();
    ~MainComponent();
    
    void paint(juce::Graphics& g) override;
    void resized() override;
    
private:
    std::unique_ptr<AppState> appState;
    
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};
