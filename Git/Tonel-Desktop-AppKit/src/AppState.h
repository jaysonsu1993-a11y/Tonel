// AppState.h — Application state (AppKit version, no JUCE dependencies)
#pragma once

#include <string>
#include <vector>
#include <atomic>
#include <functional>
#include <mutex>

// ── Participant ───────────────────────────────────────────────────────────────

struct Participant {
    int         id          = 0;
    std::string name;
    std::string instrument;   // emoji or label
    float       volume      = 1.0f;
    bool        isMuted     = false;
    bool        isConnected = true;
};

// ── AppState ──────────────────────────────────────────────────────────────────

class AppState {
public:
    enum class Screen {
        Home,
        CreateRoom,
        JoinRoom,
        Room
    };

    enum class ConnectionState {
        Disconnected,
        Connecting,
        Connected,
        Error
    };

    // ── Screen navigation ──────────────────────────────────────────────────
    void    setScreen(Screen s)    { currentScreen_ = s; notifyChange(); }
    Screen  getScreen() const      { return currentScreen_; }

    // ── Connection ─────────────────────────────────────────────────────────
    void             setConnectionState(ConnectionState s) { connectionState_ = s; notifyChange(); }
    ConnectionState  getConnectionState() const            { return connectionState_; }

    // ── Latency ────────────────────────────────────────────────────────────
    void  setLatency(int ms)          { latency_ = ms; }
    int   getLatency() const          { return latency_; }
    int   getEstimatedLatencyMs() const { return latency_; }

    // ── Room ───────────────────────────────────────────────────────────────
    void        setRoomCode(const std::string& code) { roomCode_ = code; }
    std::string getRoomCode() const                  { return roomCode_; }
    void        setRoomOwner(const std::string& id)  { roomOwner_ = id; }
    std::string getRoomOwner() const                 { return roomOwner_; }

    // ── Participants ───────────────────────────────────────────────────────
    void addParticipant(const Participant& p);
    void removeParticipant(int id);
    void updateParticipant(const Participant& p);
    void clearParticipants();
    const std::vector<Participant>& getParticipants() const { return participants_; }

    // ── Local audio controls ───────────────────────────────────────────────
    void  setMyVolume(float v) { myVolume_ = v; }
    float getMyVolume() const  { return myVolume_; }

    void  setMyMuted(bool m)   { myMuted_ = m; }
    bool  isMyMuted() const    { return myMuted_; }

    // ── Input level (thread-safe, updated from audio thread) ──────────────
    void  setInputLevel(float l) { inputLevel_.store(l, std::memory_order_release); }
    float getInputLevel() const  { return inputLevel_.load(std::memory_order_acquire); }

    // ── Change notifications ───────────────────────────────────────────────
    // Called on main thread when state changes that require UI refresh.
    void setChangeCallback(std::function<void()> cb) { changeCallback_ = std::move(cb); }

    // ── Singleton access ───────────────────────────────────────────────────
    static AppState& shared();

private:
    void notifyChange();

    Screen          currentScreen_   = Screen::Home;
    ConnectionState connectionState_ = ConnectionState::Disconnected;
    int             latency_         = 0;
    std::string     roomCode_;
    std::string     roomOwner_;
    std::vector<Participant> participants_;
    float           myVolume_        = 1.0f;
    bool            myMuted_         = false;

    std::atomic<float> inputLevel_{ 0.0f };
    std::function<void()> changeCallback_;
    mutable std::mutex mutex_;  // Protects participants_, roomCode_, connectionState_, etc.
};
