// ConfigManager.h - Desktop client centralized config reader
// Reads config.json at startup; falls back to defaults if absent.
#pragma once
#include <string>
#include <vector>

class ConfigManager {
public:
    static ConfigManager& instance();

    // Call once at app startup. Returns false if config.json not found (uses defaults).
    bool load();

    // ── Audio ──────────────────────────────────────────────
    int  audioSampleRate()    const { return audioSampleRate_; }
    int  audioBufferSize()    const { return audioBufferSize_; }
    int  audioInputChannels()  const { return audioInputChannels_; }
    int  audioOutputChannels() const { return audioOutputChannels_; }

    // ── Network ─────────────────────────────────────────────
    const std::vector<std::string>& stunServers() const { return stunServers_; }
    int  signalingPort()       const { return signalingPort_; }
    int  mixerPort()           const { return mixerPort_; }
    int  mixerWsPort()         const { return mixerWsPort_; }
    int  p2pMaxPeers()         const { return p2pMaxPeers_; }

    // ── App ───────────────────────────────────────────────
    const std::string& appId()    const { return appId_; }
    const std::string& appVersion() const { return appVersion_; }

private:
    ConfigManager() = default;

    // JSON helpers
    std::string jsonStr(const std::string& json, const std::string& key,
                        const std::string& fallback) const;
    int jsonInt(const std::string& json, const std::string& key, int fallback) const;
    int jsonNestedInt(const std::string& json, const std::string& parent,
                      const std::string& key, int fallback) const;
    std::vector<std::string> jsonStrArray(const std::string& json,
                                          const std::string& key,
                                          const std::vector<std::string>& fallback) const;

    // Find config.json — checks app bundle dir then current working directory
    std::string findConfigPath() const;

    // Defaults
    int    audioSampleRate_    = 48000;
    int    audioBufferSize_    = 256;
    int    audioInputChannels_  = 1;
    int    audioOutputChannels_ = 2;

    std::vector<std::string> stunServers_ = {"stun:stun.l.google.com:19302"};
    int    signalingPort_      = 9001;
    int    mixerPort_          = 9002;
    int    mixerWsPort_        = 9005;
    int    p2pMaxPeers_        = 4;

    std::string appId_      = "Tonel";
    std::string appVersion_ = "1.0.0";
};
