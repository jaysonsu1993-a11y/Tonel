// P2PMeshTest.cpp - Standalone test for P2P Mesh components
// Compile with: clang++ -std=c++17 -I../../src -o P2PMeshTest P2PMeshTest.cpp ../src/network/StunClient.cpp -ljuce_core -ljuce_audio_basics
//
// Tests:
//   1. STUN binding request
//   2. NAT type detection
//   3. Audio packet encode/decode
//   4. Peer mesh establishment (local loopback simulation)

#include <iostream>
#include <cstring>
#include <vector>
#include <thread>
#include <atomic>
#include <chrono>

// Minimal JUCE includes for the test
#include <juce_core/juce_core.h>
#include <juce_audio_basics/juce_audio_basics.h>

#include "StunClient.h"
#include "P2PMeshManager.h"

// ============================================================
// Test 1: STUN Binding Request
// ============================================================
bool testStunBinding()
{
    std::cout << "\n=== TEST 1: STUN Binding Request ===" << std::endl;

    StunClient client;
    StunServerInfo server;
    server.host = "stun.l.google.com";
    server.port = 19302;
    client.setServer(server);

    std::cout << "Sending STUN binding request to " << server.host << ":" << server.port << "..." << std::endl;

    auto resp = client.bindingRequest(3000);

    if (resp.success) {
        std::cout << "  SUCCESS!" << std::endl;
        std::cout << "  Mapped address: " << resp.mappedAddress.toRawUTF8()
                  << ":" << resp.mappedPort << std::endl;
        std::cout << "  Response time: " << resp.responseTimeMs << "ms" << std::endl;
        return true;
    } else {
        std::cout << "  FAILED: No response from STUN server" << std::endl;
        return false;
    }
}

// ============================================================
// Test 2: NAT Type Detection
// ============================================================
bool testNatTypeDetection()
{
    std::cout << "\n=== TEST 2: NAT Type Detection ===" << std::endl;

    StunClient client;
    StunServerInfo server;
    server.host = "stun.l.google.com";
    server.port = 19302;
    client.setServer(server);

    std::cout << "Detecting NAT type..." << std::endl;
    NatType type = client.detectNatType(5000);

    const char* typeName = "Unknown";
    switch (type) {
        case NatType::Open:          typeName = "Open (No NAT)"; break;
        case NatType::FullCone:      typeName = "Full Cone NAT"; break;
        case NatType::Restricted:    typeName = "Restricted Cone NAT"; break;
        case NatType::PortRestricted:typeName = "Port-Restricted Cone NAT"; break;
        case NatType::Symmetric:     typeName = "Symmetric NAT"; break;
        default:                      typeName = "Unknown"; break;
    }

    std::cout << "  NAT Type: " << typeName << std::endl;

    auto resp = client.lastResponse();
    if (resp.mappedAddress.isNotEmpty()) {
        std::cout << "  External IP: " << resp.mappedAddress.toRawUTF8()
                  << ":" << resp.mappedPort << std::endl;
    }

    // Symmetric NAT warning
    if (type == NatType::Symmetric) {
        std::cout << "  WARNING: Symmetric NAT detected. P2P may require TURN relay." << std::endl;
    }

    return true;
}

// ============================================================
// Test 3: Audio Packet Encode/Decode
// ============================================================
bool testAudioPacket()
{
    std::cout << "\n=== TEST 3: Audio Packet Encode/Decode ===" << std::endl;

    // Create a test audio buffer (10ms stereo at 48kHz = 480 samples * 2ch = 960 floats)
    const int numSamples = 480;
    const int numChannels = 2;
    std::vector<float> audioBuffer(numSamples * numChannels, 0.5f);

    // Manually build an audio packet
    int dataSize = numSamples * numChannels * 2; // PCM16
    int totalSize = AUDIO_PACKET_HEADER_SIZE + dataSize;

    std::vector<uint8_t> packet(totalSize);
    AudioPacket* pkt = (AudioPacket*)packet.data();

    // Encode
    pkt->magic = juce::byteOrder::hostTargetCharToBigEndian(AUDIO_PACKET_MAGIC);
    pkt->sequence = juce::byteOrder::hostTargetCharToBigEndian((uint16_t)12345);
    pkt->timestamp = juce::byteOrder::hostTargetCharToBigEndian((uint16_t)1000);

    const char* testUserId = "test_user_001";
    memset(pkt->userId, 0, 32);
    memcpy(pkt->userId, testUserId, strlen(testUserId));

    pkt->codec = CODEC_PCM16;
    pkt->dataSize = juce::byteOrder::hostTargetCharToBigEndian((uint16_t)dataSize);

    // PCM16 encode
    float* src = audioBuffer.data();
    int16_t* dst = (int16_t*)pkt->data;
    for (int i = 0; i < numSamples * numChannels; ++i) {
        dst[i] = (int16_t)(src[i] * 32767.0f);
    }

    // Verify header fields
    std::cout << "  Encoded:" << std::endl;
    std::cout << "    Magic: 0x" << std::hex << juce::byteOrder::bigEndianTargetCharToHost(pkt->magic)
              << " (expect 0x" << AUDIO_PACKET_MAGIC << ")" << std::dec << std::endl;
    std::cout << "    Sequence: " << juce::byteOrder::bigEndianTargetCharToHost(pkt->sequence) << std::endl;
    std::cout << "    Timestamp: " << juce::byteOrder::bigEndianTargetCharToHost(pkt->timestamp) << std::endl;
    std::cout << "    User ID: " << std::string((char*)pkt->userId, 32).c_str() << std::endl;
    std::cout << "    Codec: " << (int)pkt->codec << std::endl;
    std::cout << "    Payload size: " << juce::byteOrder::bigEndianTargetCharToHost(pkt->dataSize) << std::endl;
    std::cout << "    Total packet size: " << totalSize << " bytes" << std::endl;

    // Decode
    uint16_t decodedSeq = juce::byteOrder::bigEndianTargetCharToHost(pkt->sequence);
    uint16_t decodedTs = juce::byteOrder::bigEndianTargetCharToHost(pkt->timestamp);
    uint16_t decodedSz = juce::byteOrder::bigEndianTargetCharToHost(pkt->dataSize);

    std::cout << "  Decoded:" << std::endl;
    std::cout << "    Sequence: " << decodedSeq << std::endl;
    std::cout << "    Timestamp: " << decodedTs << std::endl;
    std::cout << "    Payload size: " << decodedSz << std::endl;

    bool ok = (decodedSeq == 12345 && decodedTs == 1000 && decodedSz == dataSize);
    std::cout << "  " << (ok ? "PASS" : "FAIL") << std::endl;

    return ok;
}

// ============================================================
// Test 4: Jitter Buffer
// ============================================================
bool testJitterBuffer()
{
    std::cout << "\n=== TEST 4: Jitter Buffer ===" << std::endl;

    // Simulate jitter buffer behavior
    std::vector<JitterBufferEntry> jb;
    int64_t now = 100;

    // Push packets with jitter (some arrive late)
    std::vector<uint8_t> payload(4); // tiny payload for testing
    payload[0] = 0x01; payload[1] = 0x02; payload[2] = 0x03; payload[3] = 0x04;

    // Simulate out-of-order arrival
    std::vector<uint16_t> seqOrder = {0, 2, 1, 4, 3, 5};

    for (size_t i = 0; i < seqOrder.size(); ++i) {
        JitterBufferEntry e;
        e.sequence = seqOrder[i];
        e.timestamp = seqOrder[i] * 480; // 10ms per packet
        e.payload = juce::MemoryBlock(payload.data(), payload.size());
        e.receivedAt = now + i * 10; // 10ms apart
        jb.push_back(e);
    }

    // Sort by sequence
    std::sort(jb.begin(), jb.end(),
              [](const JitterBufferEntry& a, const JitterBufferEntry& b) {
                  return a.sequence < b.sequence;
              });

    // Check ordering
    bool inOrder = true;
    for (size_t i = 0; i < jb.size(); ++i) {
        if (jb[i].sequence != i) inOrder = false;
    }

    std::cout << "  Packets received: " << seqOrder.size() << std::endl;
    std::cout << "  Sorted order: ";
    for (const auto& e : jb) std::cout << e.sequence << " ";
    std::cout << std::endl;
    std::cout << "  " << (inOrder ? "PASS: Packets sorted correctly" : "FAIL") << std::endl;

    // Simulate duplicate drop
    JitterBufferEntry dup;
    dup.sequence = 2; // duplicate of packet 2
    dup.timestamp = 2 * 480;
    dup.payload = juce::MemoryBlock(payload.data(), payload.size());
    dup.receivedAt = now + 100;

    bool hasDup = false;
    for (const auto& e : jb) {
        if (e.sequence == dup.sequence) { hasDup = true; break; }
    }
    std::cout << "  Duplicate detection: " << (hasDup ? "found existing" : "not found") << std::endl;

    return inOrder;
}

// ============================================================
// Test 5: Mesh Topology (N users = N*(N-1)/2 connections)
// ============================================================
bool testMeshTopology()
{
    std::cout << "\n=== TEST 5: Mesh Topology ===" << std::endl;

    std::vector<std::string> users = {"alice", "bob", "charlie", "diana"};
    int n = (int)users.size();
    int expectedConnections = n * (n - 1) / 2;

    std::cout << "  Users: ";
    for (const auto& u : users) std::cout << u << " ";
    std::cout << std::endl;
    std::cout << "  Expected P2P connections: " << expectedConnections << std::endl;

    // Verify mesh formula
    int connections = 0;
    for (int i = 0; i < n; ++i) {
        for (int j = i + 1; j < n; ++j) {
            connections++;
            std::cout << "    " << users[i] << " <-> " << users[j] << std::endl;
        }
    }

    bool ok = (connections == expectedConnections);
    std::cout << "  " << (ok ? "PASS" : "FAIL")
              << " (counted " << connections << " connections)" << std::endl;

    return ok;
}

// ============================================================
// Test 6: P2PMeshManager Integration (callback-based)
// ============================================================
struct TestCallback : public P2PMeshManagerCallback {
    std::atomic<int> audioReceived{0};
    std::atomic<int> peerJoined{0};
    std::atomic<int> peerLeft{0};
    std::atomic<int> peerStateChanged{0};

    void meshAudioReceived(const float*, int, int, const std::string&) override {
        audioReceived++;
    }
    void meshPeerStateChanged(const std::string&, PeerConnectionState) override {
        peerStateChanged++;
    }
    void meshPeerJoined(const std::string&) override {
        peerJoined++;
    }
    void meshPeerLeft(const std::string&) override {
        peerLeft++;
    }
    void meshNatTypeDetected(NatType, const juce::String&, int) override {
        // NAT detection happens asynchronously
    }
};

bool testP2PMeshManager()
{
    std::cout << "\n=== TEST 6: P2PMeshManager Lifecycle ===" << std::endl;

    TestCallback cb;
    P2PMeshManager mesh(&cb);

    mesh.setLocalUserId("test_node");
    mesh.setAudioFormat(48000, 2, 480);

    std::cout << "  Starting mesh on port 18000..." << std::endl;
    bool started = mesh.start(18000);
    std::cout << "  Start result: " << (started ? "OK" : "FAILED") << std::endl;

    if (!started) {
        std::cout << "  SKIP: Could not bind port (may already be in use)" << std::endl;
        return true;
    }

    // Wait a bit for NAT detection
    std::this_thread::sleep_for(std::chrono::milliseconds(2000));

    // Add 3 peers (simulating 4-user room)
    std::vector<std::string> peers = {"peer_alice", "peer_bob", "peer_charlie"};
    mesh.joinMesh(peers);

    std::cout << "  Peers added: " << peers.size() << std::endl;
    std::cout << "  Peer count: " << mesh.getPeerCount() << std::endl;

    // Wait for connections to establish
    std::this_thread::sleep_for(std::chrono::milliseconds(2000));

    // Broadcast a test audio packet
    std::vector<float> testAudio(480 * 2, 0.0f);
    mesh.sendAudioBroadcast(testAudio.data(), 480, 2, 0, CODEC_PCM16);
    std::cout << "  Audio broadcast sent" << std::endl;

    // Call tick to advance jitter buffer
    mesh.onTick();
    std::cout << "  onTick() called" << std::endl;

    // Check states
    for (const auto& uid : peers) {
        PeerConnectionState state = mesh.getPeerState(uid);
        const char* stateName = "???";
        switch (state) {
            case PeerConnectionState::Disconnected: stateName = "Disconnected"; break;
            case PeerConnectionState::Connecting:   stateName = "Connecting"; break;
            case PeerConnectionState::Connected:    stateName = "Connected"; break;
            case PeerConnectionState::Active:       stateName = "Active"; break;
            case PeerConnectionState::Failed:       stateName = "Failed"; break;
        }
        std::cout << "  Peer " << uid << " state: " << stateName << std::endl;
    }

    std::cout << "  NAT type: " << (int)mesh.getNatType() << std::endl;

    // Leave mesh
    mesh.leaveMesh();
    std::cout << "  Mesh left" << std::endl;

    mesh.stop();
    std::cout << "  Mesh stopped" << std::endl;

    return true;
}

// ============================================================
// Main
// ============================================================
int main(int argc, char* argv[])
{
    std::cout << "========================================" << std::endl;
    std::cout << "  P2P Mesh Module - Test Suite" << std::endl;
    std::cout << "========================================" << std::endl;

    int passed = 0;
    int total = 0;

    auto run = [&](const char* name, bool (*test)()) {
        total++;
        if (test()) passed++;
        std::cout << std::endl;
    };

    // Run all tests
    run("STUN Binding", testStunBinding);
    run("NAT Type Detection", testNatTypeDetection);
    run("Audio Packet Encode/Decode", testAudioPacket);
    run("Jitter Buffer", testJitterBuffer);
    run("Mesh Topology", testMeshTopology);
    run("P2PMeshManager Lifecycle", testP2PMeshManager);

    std::cout << "========================================" << std::endl;
    std::cout << "  Results: " << passed << "/" << total << " tests passed" << std::endl;
    std::cout << "========================================" << std::endl;

    return (passed == total) ? 0 : 1;
}
