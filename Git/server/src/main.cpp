#include <iostream>
#include <uv.h>
#include "signaling_server.h"

#include <fstream>
#include <sstream>
#include <regex>

// Minimal JSON int extractor — matches "key": 123
static int jsonInt(const std::string& json, const std::string& key, int fallback) {
    // Pattern: "key": <number>
    std::string pat = std::string("\"") + key + "\": *([0-9]+)";
    std::smatch m;
    if (std::regex_search(json, m, std::regex(pat))) {
        try { return std::stoi(m[1].str()); }
        catch (...) {}
    }
    return fallback;
}

static bool loadConfig(const std::string& path, int& signalingPort) {
    std::ifstream f(path);
    if (!f.is_open()) return false;
    std::stringstream ss;
    ss << f.rdbuf();
    std::string json = ss.str();
    signalingPort = jsonInt(json, "signalingPort", signalingPort);
    return true;
}

int main(int argc, char* argv[]) {
    // Load config.json (falls back to defaults on failure)
    int signalingPort = 9001;
    {
        // Try executable's directory first
        if (argc > 0 && argv[0] != nullptr) {
            std::string exePath(argv[0]);
            size_t lastSlash = exePath.find_last_of("/\\");
            if (lastSlash != std::string::npos) {
                std::string dir = exePath.substr(0, lastSlash);
                loadConfig(dir + "/config.json", signalingPort);
            }
        }
        // Also try current working directory
        loadConfig("config.json", signalingPort);
    }

    // Command-line argument overrides config
    if (argc > 1) {
        signalingPort = std::atoi(argv[1]);
    }

    uv_loop_t loop;
    uv_loop_init(&loop);

    SignalingServer server(&loop, signalingPort);
    server.start();

    std::cout << "S1 Band Rehearsal Platform - Signaling Server" << std::endl;
    std::cout << "Running on port " << signalingPort << "..." << std::endl;

    uv_run(&loop, UV_RUN_DEFAULT);

    return 0;
}
