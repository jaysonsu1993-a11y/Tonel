// BandRehearsal - P2P Audio Streaming with UI
#include <iostream>
#include <thread>
#include <atomic>
#include <vector>

#define JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED 1
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include <juce_gui_extra/juce_gui_extra.h>

// Choose audio engine backend:
//   Define S1_MINI_MODE=1 to use miniaudio (S1-mini, no JUCE audio deps)
//   Default: use JUCE AudioEngine (full S1 with JUCE audio device manager)
#ifdef S1_MINI_MODE
#include "audio/MiniaudioEngine.h"
#else
#include "audio/JuceAudioEngine.h"
#include "audio/AudioDeviceManager.h"
#endif
#include "ConfigManager.h"
#include "network/AudioRouter.h"
#include "network/MixerServerConnection.h"
#include "network/P2PMeshManager.h"
#include "network/NetworkSocket.h"
#include "network/SignalingClient.h"
#include "ui/AppState.h"
#include "ui/HomeView.h"
#include "ui/CreateRoomView.h"
#include "ui/JoinRoomView.h"
#include "ui/RoomView.h"
#include "ui/SettingsView.h"

class BandRehearsalApp : public juce::JUCEApplication,
                         public HomeViewCallback,
                         public RoomViewCallback,
                         public SettingsViewCallback,
                         public CreateRoomViewCallback,
                         public JoinRoomViewCallback,
                         public SignalingClient::Callback
{
public:
    BandRehearsalApp() = default;

    const juce::String getApplicationName() override { return "BandRehearsal"; }
    const juce::String getApplicationVersion() override { return "0.1.0"; }

    void initialise(const juce::String& commandLine) override;
    void shutdown() override;

    // HomeViewCallback
    void onCreateRoom() override;
    void onJoinRoom() override;
    void onSettings() override;

    // CreateRoomViewCallback
    void onCreateRoomConfirmed(const juce::String& roomCode, const juce::String& password) override;
    void onCreateRoomCancelled() override;

    // JoinRoomViewCallback
    void onJoinRoomConfirmed(const juce::String& roomCode, const juce::String& password) override;
    void onJoinRoomCancelled() override;

    // RoomViewCallback
    void onLeaveRoom() override;
    void onMuteToggle() override;
    void onVolumeChange(float volume) override;
    void onOpenSettings() override;

    // SettingsViewCallback
    void onSettingsClosed() override;

    // SignalingClient::Callback
    void onSignalingConnected() override;
    void onSignalingDisconnected() override;
    void onSignalingError(const std::string& error) override;
    void onRoomCreated(const std::string& roomId) override;
    void onRoomJoined(const std::string& roomId) override;
    void onPeerList(const std::string& roomId, const std::vector<SignalingPeerInfo>& peers) override;
    void onPeerJoined(const SignalingPeerInfo& peer) override;
    void onPeerLeft(const std::string& userId) override;
    void onSignalingError(const std::string& roomId, const std::string& error) override;

    AppState& getAppState() { return *appState; }
    AudioDeviceManagerWrapper& getAudioDeviceManagerWrapper() { return *audioDeviceManager; }

private:
    class MainWindow : public juce::DocumentWindow
    {
    public:
        MainWindow(const juce::String& name, BandRehearsalApp& app);

        void switchToRoomView();
        void switchToHomeView();
        void switchToSettingsView();
        void switchToCreateRoomView();
        void switchToJoinRoomView();

    private:
        BandRehearsalApp& app;
        std::unique_ptr<HomeView> homeView;
        std::unique_ptr<RoomView> roomView;
        std::unique_ptr<SettingsView> settingsView;
        std::unique_ptr<CreateRoomView> createRoomView;
        std::unique_ptr<JoinRoomView> joinRoomView;
    };

    std::unique_ptr<MainWindow> mainWindow;
    std::unique_ptr<AppState> appState;
    std::unique_ptr<AudioDeviceManagerWrapper> audioDeviceManager;
#ifdef S1_MINI_MODE
    std::unique_ptr<AudioEngine> audioEngine;
#else
    std::unique_ptr<JuceAudioEngine> audioEngine;
#endif

    // Network audio routing
    std::unique_ptr<AudioRouter> audioRouter_;
    std::unique_ptr<P2PMeshManager> p2pMesh_;  // owned by AudioRouter after setP2PMeshManager

    // Signaling (room passwords, peer discovery)
    std::unique_ptr<SignalingClient> signalingClient_;

    // Pending room params waiting for signaling callback
    juce::String pendingRoomCode_;
    juce::String pendingPassword_;
    bool pendingIsCreating_ = false;
};

void BandRehearsalApp::initialise(const juce::String& commandLine)
{
    // ── Load config (falls back to defaults if config.json absent) ──
    ConfigManager::instance().load();
    auto& cfg = ConfigManager::instance();

    appState = std::make_unique<AppState>();
    audioDeviceManager = std::make_unique<AudioDeviceManagerWrapper>();

    // ── Create AudioRouter ────────────────────────────────────
    audioRouter_ = std::make_unique<AudioRouter>();

    // ── Create SignalingClient ─────────────────────────────────
    signalingClient_ = std::make_unique<SignalingClient>();
    signalingClient_->setCallback(this);
    signalingClient_->connect("127.0.0.1", cfg.signalingPort());

    // ── Create MixerServerConnection (AudioRouter takes ownership) ──
    audioRouter_->setMixerServerConnection(new MixerServerConnection());
    audioRouter_->setDefaultMixerServer("127.0.0.1", cfg.mixerPort());

    // ── Create P2P mesh manager ───────────────────────────────
    // (P2P is configured here; AudioRouter references it but does not own it)
    p2pMesh_ = std::make_unique<P2PMeshManager>(audioRouter_.get());
    // Note: audio.bufferSize (256) is the JUCE device buffer.
    // Opus packet size (480 samples = 10 ms @ 48 kHz) is set separately.
    p2pMesh_->setAudioFormat(cfg.audioSampleRate(), cfg.audioOutputChannels(), 480);
    audioRouter_->setP2PMeshManager(p2pMesh_.get());

    // ── Create audio engine ───────────────────────────────────
#ifdef S1_MINI_MODE
    audioEngine = std::make_unique<MiniaudioEngine>();
    if (!audioEngine->initialize()) {
        printf("Failed to initialize MiniaudioEngine\n");
    }
#else
    // JuceAudioEngine uses the SAME AudioDeviceManager as SettingsView
    audioEngine = std::make_unique<JuceAudioEngine>(*audioDeviceManager);
#endif

    // ── Wire audio engine to AudioRouter ──────────────────────
    // This enables: engine captures mic → AudioRouter → P2P/Mixer
    //              and: AudioRouter receives → engine plays
#ifndef S1_MINI_MODE
    // JUCE backend
    if (auto* juceEngine = dynamic_cast<JuceAudioEngine*>(audioEngine.get())) {
        juceEngine->setAudioRouter(audioRouter_.get());
    }
#else
    // miniaudio backend
    if (auto* miniEngine = dynamic_cast<MiniaudioEngine*>(audioEngine.get())) {
        miniEngine->setAudioRouter(audioRouter_.get());
    }
#endif

    mainWindow = std::make_unique<MainWindow>(getApplicationName(), *this);
    mainWindow->setVisible(true);
}

void BandRehearsalApp::shutdown()
{
    audioRouter_->stop();
    audioEngine->stop();
    // AudioRouter destructor deletes MixerServerConnection (it owns it)
    // p2pMesh_ must outlive audioRouter_ since AudioRouter references it
    audioRouter_.reset();
    p2pMesh_.reset();
    audioEngine.reset();
    mainWindow.reset();
    audioDeviceManager.reset();
}

void BandRehearsalApp::onCreateRoom()
{
    mainWindow->switchToCreateRoomView();
}

void BandRehearsalApp::onJoinRoom()
{
    mainWindow->switchToJoinRoomView();
}

void BandRehearsalApp::onCreateRoomConfirmed(const juce::String& roomCode, const juce::String& password)
{
    if (roomCode.isEmpty()) {
        mainWindow->switchToHomeView();
        return;
    }
    pendingRoomCode_ = roomCode;
    pendingPassword_ = password;
    pendingIsCreating_ = true;
    signalingClient_->createRoom(roomCode.toStdString(), "local-user", password.toStdString());
}

void BandRehearsalApp::onCreateRoomCancelled()
{
    mainWindow->switchToHomeView();
}

void BandRehearsalApp::onJoinRoomConfirmed(const juce::String& roomCode, const juce::String& password)
{
    if (roomCode.isEmpty()) {
        mainWindow->switchToHomeView();
        return;
    }
    pendingRoomCode_ = roomCode;
    pendingPassword_ = password;
    pendingIsCreating_ = false;
    signalingClient_->joinRoom(roomCode.toStdString(), "remote-user", password.toStdString());
}

void BandRehearsalApp::onJoinRoomCancelled()
{
    mainWindow->switchToHomeView();
}

// ── SignalingClient::Callback ──────────────────────────────────

void BandRehearsalApp::onSignalingConnected()
{
    printf("[Signaling] connected\n");
}

void BandRehearsalApp::onSignalingDisconnected()
{
    printf("[Signaling] disconnected\n");
}

void BandRehearsalApp::onSignalingError(const std::string& error)
{
    printf("[Signaling] error: %s\n", error.c_str());
}

void BandRehearsalApp::onRoomCreated(const std::string& roomId)
{
    printf("[Signaling] room created: %s\n", roomId.c_str());
    appState->setRoomCode(juce::String(roomId));
    appState->setLatency(12);
    appState->setConnectionState(AppState::ConnectionState::Connected);

    audioRouter_->setLocalUserId("local-user");
    audioRouter_->setMixerRoomId(roomId);
    audioRouter_->init(4);

    Participant me = {0, juce::CharPointer_UTF8("我"), juce::CharPointer_UTF8("🎤"), 1.0f, false, true};
    appState->addParticipant(me);

    std::thread([this]() {
        audioRouter_->start();
        audioEngine->start();
    }).detach();

    mainWindow->switchToRoomView();
}

void BandRehearsalApp::onRoomJoined(const std::string& roomId)
{
    printf("[Signaling] room joined: %s\n", roomId.c_str());
    appState->setRoomCode(juce::String(roomId));
    appState->setLatency(15);
    appState->setConnectionState(AppState::ConnectionState::Connected);

    audioRouter_->setLocalUserId("remote-user");
    audioRouter_->setMixerRoomId(roomId);
    audioRouter_->init(2);

    Participant me = {0, juce::CharPointer_UTF8("我"), juce::CharPointer_UTF8("🎤"), 1.0f, false, true};
    appState->addParticipant(me);

    std::thread([this]() {
        audioRouter_->start();
        audioEngine->start();
    }).detach();

    mainWindow->switchToRoomView();
}

void BandRehearsalApp::onPeerList(const std::string& roomId, const std::vector<SignalingPeerInfo>& peers)
{
    printf("[Signaling] peer list for room %s: %zu peers\n", roomId.c_str(), peers.size());
}

void BandRehearsalApp::onPeerJoined(const SignalingPeerInfo& peer)
{
    printf("[Signaling] peer joined: %s\n", peer.user_id.c_str());
}

void BandRehearsalApp::onPeerLeft(const std::string& userId)
{
    printf("[Signaling] peer left: %s\n", userId.c_str());
}

void BandRehearsalApp::onSignalingError(const std::string& roomId, const std::string& error)
{
    juce::AlertWindow::showMessageBoxAsync(
        juce::AlertWindow::WarningIcon,
        juce::CharPointer_UTF8("房间错误"),
        juce::String(juce::CharPointer_UTF8("无法进入房间: ")) + error.c_str());
    mainWindow->switchToHomeView();
    (void)roomId;
}

void BandRehearsalApp::onSettings()
{
    mainWindow->switchToSettingsView();
}

void BandRehearsalApp::onLeaveRoom()
{
    audioEngine->stop();
    audioRouter_->stop();
    appState->clearParticipants();
    mainWindow->switchToHomeView();
}

void BandRehearsalApp::onMuteToggle()
{
    appState->setMyMuted(!appState->isMyMuted());
}

void BandRehearsalApp::onVolumeChange(float volume)
{
    appState->setMyVolume(volume);
}

void BandRehearsalApp::onOpenSettings()
{
    mainWindow->switchToSettingsView();
}

void BandRehearsalApp::onSettingsClosed()
{
    mainWindow->switchToHomeView();
}

BandRehearsalApp::MainWindow::MainWindow(const juce::String& name, BandRehearsalApp& app)
    : DocumentWindow(name, juce::Colour::fromRGB(19, 18, 18), 1024, 768)
    , app(app)
{
    setUsingNativeTitleBar(true);
    setTitleBarButtonsRequired (juce::DocumentWindow::minimiseButton | juce::DocumentWindow::closeButton, false);
    setResizable(true, false);
    centreWithSize(1024, 768);

    homeView = std::make_unique<HomeView>();
    roomView = std::make_unique<RoomView>();
    createRoomView = std::make_unique<CreateRoomView>();
    joinRoomView = std::make_unique<JoinRoomView>();
    homeView->setCallback(&app);
    roomView->setCallback(&app);
    createRoomView->setCallback(&app);
    joinRoomView->setCallback(&app);

    settingsView = std::make_unique<SettingsView>(app.getAudioDeviceManagerWrapper());
    settingsView->setCallback(&app);

    setContentNonOwned(homeView.get(), true);
    getContentComponent()->setSize(1024, 768);
}

void BandRehearsalApp::MainWindow::switchToRoomView()
{
    roomView->setAppState(&app.getAppState());
    roomView->setAudioEngine(app.audioEngine.get());
    roomView->setAudioDeviceManager(&app.getAudioDeviceManagerWrapper());
    setContentNonOwned(roomView.get(), true);
    getContentComponent()->setSize(1024, 768);
    roomView->resized(); // Ensure cards are laid out on first display
}

void BandRehearsalApp::MainWindow::switchToHomeView()
{
    setContentNonOwned(homeView.get(), true);
    getContentComponent()->setSize(1024, 768);
}

void BandRehearsalApp::MainWindow::switchToSettingsView()
{
    settingsView->resized(); // refresh layout
    setContentNonOwned(settingsView.get(), true);
    getContentComponent()->setSize(1024, 768);
}

void BandRehearsalApp::MainWindow::switchToCreateRoomView()
{
    setContentNonOwned(createRoomView.get(), true);
    getContentComponent()->setSize(1024, 768);
    createRoomView->resized();
}

void BandRehearsalApp::MainWindow::switchToJoinRoomView()
{
    setContentNonOwned(joinRoomView.get(), true);
    getContentComponent()->setSize(1024, 768);
    joinRoomView->resized();
}

START_JUCE_APPLICATION(BandRehearsalApp)
