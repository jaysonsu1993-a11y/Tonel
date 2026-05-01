// JuceAudioEngine.cpp - JUCE-based audio engine implementation
#include "JuceAudioEngine.h"
#include "AudioDeviceManager.h"
#include "network/AudioRouter.h"
#include "ConfigManager.h"
#include <cmath>

JuceAudioEngine::JuceAudioEngine(AudioDeviceManagerWrapper& wrapper)
    : wrapper_(wrapper)
    , manager_(wrapper.getManager())
{
    inputBuffer_.setSize(2, 256);
    outputBuffer_.setSize(2, 256);
    printf("JuceAudioEngine created (JUCE backend)\n");
}

JuceAudioEngine::~JuceAudioEngine()
{
    stop();
}

bool JuceAudioEngine::initialize()
{
    return true;
}

void JuceAudioEngine::shutdown()
{
    stop();
}

void JuceAudioEngine::setInputDevice(int index)
{
    juce::StringArray devices = wrapper_.getInputDevices();
    if (index >= 0 && index < devices.size()) {
        wrapper_.setInputDevice(devices[index]);
    }
}

void JuceAudioEngine::setOutputDevice(int index)
{
    juce::StringArray devices = wrapper_.getOutputDevices();
    if (index >= 0 && index < devices.size()) {
        wrapper_.setOutputDevice(devices[index]);
    }
}

void JuceAudioEngine::start()
{
    if (running_) return;

    // ── CRITICAL: initialiseWithDefaultDevices MUST be called before
    // setAudioDeviceSetup to open the default audio device with INPUT channels.
    // Without this, setAudioDeviceSetup with empty names returns early and
    // no input device is ever opened — microphone input stays at -60 dB.
    // This call also triggers the macOS microphone permission dialog on first run.
    juce::String initError = manager_.initialiseWithDefaultDevices(
        ConfigManager::instance().audioInputChannels(),
        ConfigManager::instance().audioOutputChannels());
    if (initError.isNotEmpty()) {
        printf("JuceAudioEngine: initialiseWithDefaultDevices FAILED: %s\n",
               initError.toRawUTF8());
    } else {
        printf("JuceAudioEngine: initialiseWithDefaultDevices OK\n");
    }

    {
        juce::AudioDeviceManager::AudioDeviceSetup setup;
        setup.inputDeviceName  = juce::String();  // default
        setup.outputDeviceName = juce::String();  // default
        setup.sampleRate       = (double)ConfigManager::instance().audioSampleRate();
        setup.bufferSize       = ConfigManager::instance().audioBufferSize();
        manager_.setAudioDeviceSetup(setup, true);
    }
    manager_.addAudioCallback(this);
    manager_.addChangeListener(this);
    running_ = true;
    printf("JuceAudioEngine started\n");
}

void JuceAudioEngine::setCallback(AudioEngineCallback* cb)
{
    callback_ = cb;
}

void JuceAudioEngine::setAudioRouter(AudioRouter* router)
{
    audioRouter_ = router;
}

void JuceAudioEngine::stop()
{
    if (!running_) return;
    manager_.removeAudioCallback(this);
    manager_.removeChangeListener(this);
    running_ = false;
    printf("JuceAudioEngine stopped\n");
}

bool JuceAudioEngine::isRunning() const
{
    return running_;
}

void JuceAudioEngine::audioDeviceAboutToStart(juce::AudioIODevice* device)
{
    currentSampleRate_ = device->getCurrentSampleRate();
    currentBufferSize_ = device->getCurrentBufferSizeSamples();
    // Use INPUT channel count for the input buffer; output channels for output buffer.
    int inCh = device->getInputChannelNames().size();
    int outCh = device->getOutputChannelNames().size();
    numChannels_ = (inCh > 0) ? inCh : outCh;
    if (numChannels_ < 2) numChannels_ = 2;
    inputBuffer_.setSize(numChannels_, currentBufferSize_);
    outputBuffer_.setSize(numChannels_, currentBufferSize_);
    printf("JuceAudioEngine: aboutToStart sr=%.0f buf=%d inCh=%d outCh=%d\n",
           currentSampleRate_, currentBufferSize_, inCh, outCh);
}

void JuceAudioEngine::audioDeviceStopped()
{
    inputLevel_.store(0.0f, std::memory_order_release);
    printf("JuceAudioEngine: stopped\n");
}

void JuceAudioEngine::audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                                       int totalNumInputChannels,
                                                       float* const* outputChannelData,
                                                       int totalNumOutputChannels,
                                                       int numSamples,
                                                       const juce::AudioIODeviceCallbackContext&)
{
    // Debug: log first few callbacks to verify audio is flowing
    static int dbgCount = 0;
    if (dbgCount < 5) {
        // Compute peak sample value to diagnose silence vs. no-channel
        float peak = 0.0f;
        if (inputChannelData && totalNumInputChannels > 0) {
            for (int ch = 0; ch < totalNumInputChannels && ch < 8; ++ch) {
                for (int s = 0; s < numSamples && s < 16; ++s) {
                    float v = std::abs(inputChannelData[ch][s]);
                    if (v > peak) peak = v;
                }
            }
        }
        printf("[AudioCallback] count=%d inputCh=%d outputCh=%d samples=%d peak=%.4f\n",
               dbgCount, totalNumInputChannels, totalNumOutputChannels, numSamples, peak);
        dbgCount++;
    }

    // ── Capture: send local mic audio to AudioRouter ───────────────
    if (inputChannelData && totalNumInputChannels > 0) {
        // P1-4: Interleave all input channels into a contiguous buffer.
        // inputChannelData is planar: [ch0][ch1]... but the router expects
        // interleaved: [s0ch0, s0ch1, s1ch0, s1ch1, ...].
        std::vector<float> interleaved(numSamples * totalNumInputChannels);
        for (int ch = 0; ch < totalNumInputChannels; ++ch) {
            const float* src = inputChannelData[ch];
            for (int s = 0; s < numSamples; ++s) {
                interleaved[s * totalNumInputChannels + ch] = src[s];
            }
        }

        // ── Compute RMS level from the captured mic input ──────────────
        // Accumulate sum of squares across all channels and samples
        float sumSq = 0.0f;
        for (int s = 0; s < numSamples * totalNumInputChannels; ++s) {
            float samps = interleaved[s];
            sumSq += samps * samps;
        }
        int totalSamples = numSamples * totalNumInputChannels;
        float rms = std::sqrt(sumSq / static_cast<float>(totalSamples));
        // Apply exponential smoothing: 20% new RMS / 80% hold
        float prev = inputLevel_.load(std::memory_order_relaxed);
        float smoothed = prev + LEVEL_SMOOTHING * (rms - prev);
        inputLevel_.store(smoothed, std::memory_order_release);

        // Send to router if connected
        if (audioRouter_) {
            audioRouter_->onLocalAudioReady(interleaved.data(), numSamples, totalNumInputChannels);
        }
    }

    // ── Playback: pull remote/mixed audio from AudioRouter ─────────
    if (audioRouter_) {
        std::vector<float> playbackBuffer(numSamples * 2);
        bool hasPlayback = audioRouter_->getMixerPlayableSamples(
            playbackBuffer.data(), numSamples * 2);

        if (hasPlayback) {
            int frames = numSamples;
            for (int ch = 0; ch < totalNumOutputChannels; ++ch) {
                if (!outputChannelData[ch]) continue;
                for (int i = 0; i < frames; ++i) {
                    int idx = i * 2 + ch;
                    outputChannelData[ch][i] = juce::jlimit(-1.0f, 1.0f, playbackBuffer[idx]);
                }
            }
        } else {
            for (int ch = 0; ch < totalNumOutputChannels; ++ch) {
                if (outputChannelData[ch])
                    juce::FloatVectorOperations::clear(outputChannelData[ch], numSamples);
            }
        }
    } else {
        // No router: clear output (pass-through would require explicit wiring)
        for (int ch = 0; ch < totalNumOutputChannels; ++ch) {
            if (outputChannelData[ch])
                juce::FloatVectorOperations::clear(outputChannelData[ch], numSamples);
        }
    }

    // ── Legacy callback (mic monitoring / waveform display) ─────────
    if (callback_ && inputChannelData) {
        callback_->audioReceived(inputChannelData[0], numSamples, totalNumInputChannels);
    }
}

void JuceAudioEngine::changeListenerCallback(juce::ChangeBroadcaster*)
{
    printf("JuceAudioEngine: device change detected, restarting...\n");
    restartAudio();
}

void JuceAudioEngine::restartAudio()
{
    bool wasRunning = running_;
    if (wasRunning) {
        manager_.removeAudioCallback(this);
        running_ = false;
        if (auto* dev = manager_.getCurrentAudioDevice()) {
            currentSampleRate_ = dev->getCurrentSampleRate();
            currentBufferSize_ = dev->getCurrentBufferSizeSamples();
            numChannels_ = dev->getOutputChannelNames().size();
            if (numChannels_ < 2) numChannels_ = 2;
        }
        manager_.addAudioCallback(this);
        running_ = true;
        printf("JuceAudioEngine: restarted\n");
    }
}
