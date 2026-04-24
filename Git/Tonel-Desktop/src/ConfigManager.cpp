#include "ConfigManager.h"
#include <juce_core/juce_core.h>
#include <fstream>
#include <sstream>
#include <regex>

ConfigManager& ConfigManager::instance() {
    static ConfigManager inst;
    return inst;
}

std::string ConfigManager::findConfigPath() const {
    // Try app binary directory first (for installed app)
    juce::File appDir = juce::File::getSpecialLocation(juce::File::currentApplicationFile)
                            .getParentDirectory();
    juce::File configInAppDir = appDir.getChildFile("config.json");
    if (configInAppDir.existsAsFile())
        return configInAppDir.getFullPathName().toStdString();

    // Fall back to current working directory
    juce::File configCwd = juce::File::getCurrentWorkingDirectory().getChildFile("config.json");
    if (configCwd.existsAsFile())
        return configCwd.getFullPathName().toStdString();

    return {};
}

bool ConfigManager::load() {
    std::string path = findConfigPath();
    if (path.empty()) {
        juce::Logger::writeToLog("ConfigManager: config.json not found, using defaults");
        return false;
    }

    std::ifstream f(path);
    if (!f.is_open()) {
        juce::Logger::writeToLog("ConfigManager: could not open " + path);
        return false;
    }

    std::stringstream ss;
    ss << f.rdbuf();
    std::string json = ss.str();

    // ── audio ───────────────────────────────────────────────────────────
    audioSampleRate_    = jsonInt(json, "sample_rate", audioSampleRate_);
    audioBufferSize_    = jsonInt(json, "buffer_size", audioBufferSize_);
    audioInputChannels_  = jsonInt(json, "input_channels", audioInputChannels_);
    audioOutputChannels_ = jsonInt(json, "output_channels", audioOutputChannels_);

    // ── network ────────────────────────────────────────────
    stunServers_ = jsonStrArray(json, "stunServers", stunServers_);
    signalingPort_ = jsonInt(json, "signalingPort", signalingPort_);
    mixerPort_     = jsonInt(json, "mixerPort", mixerPort_);
    mixerWsPort_   = jsonInt(json, "mixerWsPort", mixerWsPort_);
    p2pMaxPeers_   = jsonNestedInt(json, "p2p", "maxPeers", p2pMaxPeers_);

    // ── app ────────────────────────────────────────────────
    appId_      = jsonStr(json, "appId", appId_);
    appVersion_ = jsonStr(json, "version", appVersion_);

    juce::Logger::writeToLog("ConfigManager: loaded from " + path);
    return true;
}

// ---- JSON helpers ----
std::string ConfigManager::jsonStr(const std::string& json,
                                    const std::string& key,
                                    const std::string& fallback) const {
    std::string pat = "\"" + key + "\"\\s*:\\s*\"([^\"]*)\"";
    std::smatch m;
    if (std::regex_search(json, m, std::regex(pat))) return m[1].str();
    return fallback;
}

int ConfigManager::jsonInt(const std::string& json,
                            const std::string& key,
                            int fallback) const {
    std::string pat = "\"" + key + "\"\\s*:\\s*([0-9]+)";
    std::smatch m;
    if (std::regex_search(json, m, std::regex(pat))) {
        try { return std::stoi(m[1].str()); }
        catch (...) {}
    }
    return fallback;
}

int ConfigManager::jsonNestedInt(const std::string& json,
                                  const std::string& parent,
                                  const std::string& key,
                                  int fallback) const {
    std::string pat = "\"" + parent + "\"\\s*:\\s*\\{([^}]*)\\}";
    std::smatch m;
    if (!std::regex_search(json, m, std::regex(pat))) return fallback;
    return jsonInt(m[1].str(), key, fallback);
}

std::vector<std::string> ConfigManager::jsonStrArray(const std::string& json,
                                                     const std::string& key,
                                                     const std::vector<std::string>& fallback) const {
    std::string arrPat = "\"" + key + "\"\\s*:\\s*\\[([^\\]]*)\\]";
    std::smatch m;
    if (!std::regex_search(json, m, std::regex(arrPat))) return fallback;

    std::string arr = m[1].str();
    std::vector<std::string> result;
    std::regex itemRe("\"([^\"]*)\"");
    for (auto it = std::sregex_iterator(arr.begin(), arr.end(), itemRe);
         it != std::sregex_iterator(); ++it) {
        result.push_back((*it)[1].str());
    }
    return result.empty() ? fallback : result;
}
