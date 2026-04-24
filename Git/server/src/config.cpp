#include "config.h"
#include <fstream>
#include <sstream>
#include <regex>

ServerConfig g_config;

// ---- Minimal JSON value extractor ----
static std::string jsonStr(const std::string& json, const std::string& key,
                           const std::string& fallback) {
    std::string pattern = "\"" + key + "\"\\s*:\\s*\"([^\"]*)\"";
    std::regex re(pattern);
    std::smatch m;
    if (std::regex_search(json, m, re)) return m[1].str();
    return fallback;
}

static int jsonInt(const std::string& json, const std::string& key, int fallback) {
    std::string pattern = "\"" + key + "\"\\s*:\\s*([0-9]+)";
    std::regex re(pattern);
    std::smatch m;
    if (std::regex_search(json, m, re)) {
        try { return std::stoi(m[1].str()); }
        catch (...) {}
    }
    return fallback;
}

static int jsonNestedInt(const std::string& json,
                          const std::string& parent, const std::string& key,
                          int fallback) {
    // Find parent object { ... }
    std::string parentPat = "\"" + parent + "\"\\s*:\\s*\\{([^}]*)\\}";
    std::regex re(parentPat);
    std::smatch m;
    if (!std::regex_search(json, m, re)) return fallback;
    return jsonInt(m[1].str(), key, fallback);
}

bool ServerConfig::load(const std::string& path) {
    std::ifstream f(path);
    if (!f.is_open()) {
        return false;  // Use defaults
    }

    std::stringstream ss;
    ss << f.rdbuf();
    std::string content = ss.str();

    // Audio (top-level fields for server simplicity)
    audioSampleRate       = jsonInt(content, "sample_rate", audioSampleRate);
    audioBufferSize       = jsonInt(content, "buffer_size", audioBufferSize);
    audioInputChannels   = jsonInt(content, "input_channels", audioInputChannels);
    audioOutputChannels  = jsonInt(content, "output_channels", audioOutputChannels);

    // Network
    signalingPort         = jsonInt(content, "signaling_port", signalingPort);
    mixerPort             = jsonInt(content, "mixer_port", mixerPort);

    // App
    appId      = jsonStr(content, "id", appId);
    appVersion = jsonStr(content, "version", appVersion);

    return true;
}
