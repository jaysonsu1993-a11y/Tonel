// AppState.h - Application state management
#pragma once

#include <juce_core/juce_core.h>
#include <vector>
#include <string>
#include <atomic>

struct Participant
{
    int id;
    juce::String name;
    juce::String instrument;
    float volume = 1.0f;
    bool isMuted = false;
    bool isConnected = true;
};

class AppState
{
public:
    enum class Screen
    {
        Home,
        CreateRoom,
        JoinRoom,
        Room
    };
    
    enum class ConnectionState
    {
        Disconnected,
        Connecting,
        Connected,
        Error
    };
    
    void setScreen(Screen s) { currentScreen = s; }
    Screen getScreen() const { return currentScreen; }
    
    void setConnectionState(ConnectionState s) { connectionState = s; }
    ConnectionState getConnectionState() const { return connectionState; }
    
    void setLatency(int ms) { latency = ms; }
    int getLatency() const { return latency; }

    // Estimated round-trip latency in milliseconds (for display).
    // Currently returns the reported latency; can be refined with RTT pings.
    int getEstimatedLatencyMs() const { return latency; }
    
    void setRoomCode(const juce::String& code) { roomCode = code; }
    juce::String getRoomCode() const { return roomCode; }
    
    void addParticipant(const Participant& p) { participants.push_back(p); }
    void removeParticipant(int id);
    void updateParticipant(const Participant& p);
    void clearParticipants() { participants.clear(); }
    const std::vector<Participant>& getParticipants() const { return participants; }
    
    void setMyVolume(float v) { myVolume = v; }
    float getMyVolume() const { return myVolume; }
    
    void setMyMuted(bool m) { myMuted = m; }
    bool isMyMuted() const { return myMuted; }

    // Audio input level (0.0–1.0, updated from audio thread)
    void setInputLevel(float l) { inputLevel_.store(l, std::memory_order_release); }
    float getInputLevel() const { return inputLevel_.load(std::memory_order_acquire); }

    // Pending dialog callback (used by create/join room dialogs)
    // (future: for async dialog result handling)

private:
    Screen currentScreen = Screen::Home;
    ConnectionState connectionState = ConnectionState::Disconnected;
    int latency = 0;
    juce::String roomCode;
    std::vector<Participant> participants;
    float myVolume = 1.0f;
    bool myMuted = false;

    // Real-time audio input level (thread-safe)
    std::atomic<float> inputLevel_{ 0.0f };
};
