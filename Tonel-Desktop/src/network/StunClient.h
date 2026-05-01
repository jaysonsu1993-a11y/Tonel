// StunClient.h - RFC 5389 STUN client for NAT type detection and UDP hole punching
#pragma once

#include <juce_core/juce_core.h>
#include <string>

struct StunServerInfo {
    juce::String host;
    int port = 3478;
};

struct StunBindingResponse {
    bool success = false;
    juce::String mappedAddress;  // our external IP
    int mappedPort = 0;
    juce::String sourceAddress;   // server IP we sent from
    int sourcePort = 0;
    int responseTimeMs = 0;
};

enum class NatType {
    Unknown,
    Open,        // No NAT, public IP
    FullCone,    // Full cone NAT - easiest to punch
    Restricted,  // Restricted cone NAT
    PortRestricted, // Port-restricted cone NAT
    Symmetric    // Symmetric NAT - hardest to punch, may need relay
};

class StunClient {
public:
    StunClient();

    // Set the STUN server to use
    void setServer(const StunServerInfo& server);

    // Perform a STUN binding request (RFC 5389)
    // Returns the mapped address (our external IP:port)
    StunBindingResponse bindingRequest(int timeoutMs = 3000);

    // Detect NAT type by testing behavior
    // Requires testing with 2 different STUN servers
    NatType detectNatType(int timeoutMs = 3000);

    // Simple firewall test: are we reachable from outside?
    bool isReachable(int timeoutMs = 3000);

    // Get the last known mapped address
    const StunBindingResponse& lastResponse() const { return lastResponse_; }

private:
    static constexpr uint16_t STUN_PORT = 3478;
    static constexpr uint32_t STUN_MAGIC_COOKIE = 0x2112A442;

    enum class StunMessageType : uint16_t {
        BindingRequest     = 0x0001,
        BindingResponse    = 0x0101,
        BindingError       = 0x0111,
        SharedSecretRequest = 0x0002,
        SharedSecretResponse = 0x0102,
        SharedSecretError   = 0x0112
    };

    struct StunHeader {
        uint16_t type;
        uint16_t length;
        uint32_t magicCookie;
        uint8_t transactionId[12];
    };

    // Build a raw binding request packet
    juce::MemoryBlock buildBindingRequest();

    // Parse a STUN response (binding success or error)
    StunBindingResponse parseResponse(const void* data, int size);

    // Send and receive with timeout using JUCE sockets
    StunBindingResponse sendAndReceive(const juce::MemoryBlock& request, int timeoutMs);

    std::unique_ptr<juce::DatagramSocket> socket_;
    StunServerInfo server_;
    StunBindingResponse lastResponse_;
    juce::uint8 transactionId_[12];

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(StunClient)
};
