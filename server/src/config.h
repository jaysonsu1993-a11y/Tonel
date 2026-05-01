#pragma once
#include <string>

// ============================================================
// S1 Server Config — loaded from config.json at startup
// Falls back to defaults if file is absent or parse fails.
// ============================================================

struct ServerConfig {
    // Audio
    int audioSampleRate   = 48000;
    int audioBufferSize   = 256;
    int audioInputChannels  = 1;
    int audioOutputChannels = 2;
    int audioFrames      = 480;   // samples per audio packet (10 ms @ 48 kHz)

    // Network
    int signalingPort = 9001;
    int mixerPort     = 9002;
    int mixerUdpPort  = 9002;   // same as mixerPort in current implementation

    // App
    std::string appId    = "Tonel";
    std::string appVersion = "1.0.0";

    // ---- Load from config.json ----------------------------------------
    // If file doesn't exist or can't be parsed, returns false and
    // leaves the struct populated with defaults.
    bool load(const std::string& path);
};

// Global config instance (signaling + mixer servers share it)
extern ServerConfig g_config;
