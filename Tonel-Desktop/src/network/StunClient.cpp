// StunClient.cpp - RFC 5389 STUN client implementation
#include "StunClient.h"
#include "ConfigManager.h"
#include <chrono>

// Parse "stun:host:port" or "host:port" from config
static StunServerInfo defaultStunServerFromConfig() {
    StunServerInfo info;
    auto& cfg = ConfigManager::instance();
    const auto& servers = cfg.stunServers();
    if (!servers.empty()) {
        const std::string& entry = servers[0];
        // Strip "stun:" prefix if present
        std::string rest = entry;
        if (rest.find("stun:") == 0) rest = rest.substr(5);
        // Split on last ':'
        size_t colon = rest.find_last_of(':');
        if (colon != std::string::npos) {
            info.host = rest.substr(0, colon);
            try { info.port = std::stoi(rest.substr(colon + 1)); } catch (...) {}
        } else {
            info.host = rest;
        }
    }
    if (info.host.isEmpty()) {
        info.host = "stun.l.google.com";
        info.port = 19302;
    }
    return info;
}

StunClient::StunClient()
{
    socket_ = std::make_unique<juce::DatagramSocket>(false); // non-blocking
}

// STUN attribute types
static constexpr uint16_t ATTR_MAPPED_ADDRESS     = 0x0001;
static constexpr uint16_t ATTR_XOR_MAPPED_ADDRESS = 0x0020;
static constexpr uint16_t ATTR_XOR_MAPPED_ADDRESS2 = 0x8020;
static constexpr uint16_t ATTR_CHANGE_REQUEST      = 0x0003;
static constexpr uint16_t ATTR_USERNAME            = 0x0006;
static constexpr uint16_t ATTR_ERROR_CODE         = 0x0009;

void StunClient::setServer(const StunServerInfo& server)
{
    server_ = server;
}

juce::MemoryBlock StunClient::buildBindingRequest()
{
    // Generate random transaction ID
    juce::Random r;
    for (int i = 0; i < 12; ++i)
        transactionId_[i] = (uint8_t)r.nextInt(256);

    // STUN header: type(2) + length(2) + magic cookie(4) + transaction ID(12) = 20 bytes
    juce::MemoryBlock msg(20);
    uint8_t* p = (uint8_t*)msg.getData();

    // Type: Binding Request (0x0001) - big endian
    uint8_t typeBytes[2] = { 0x00, 0x01 };
    memcpy(p, typeBytes, 2);
    // Length: 0 (no attributes in basic binding request)
    uint8_t lenBytes[2] = { 0x00, 0x00 };
    memcpy(p + 2, lenBytes, 2);
    // Magic cookie: 0x2112A442 - big endian
    uint8_t magicBytes[4] = { 0x21, 0x12, 0xA4, 0x42 };
    memcpy(p + 4, magicBytes, 4);
    // Transaction ID (12 bytes)
    memcpy(p + 8, transactionId_, 12);

    // Store transaction ID for response matching
    return msg;
}

// Parse XOR-MAPPED-ADDRESS (RFC 5389)
// Port is XOR'd with top 16 bits of magic cookie
// IP is XOR'd with magic cookie
static bool parseXorMappedAddress(const uint8_t* attr, int attrLen,
                                   StunBindingResponse& out)
{
    if (attrLen < 8) return false;

    uint8_t family = attr[1];
    if (family != 0x01) return false; // only IPv4

    uint16_t portRaw = ((uint16_t)attr[2] << 8) | attr[3];
    uint32_t ipRaw   = ((uint32_t)attr[4] << 24) |
                        ((uint32_t)attr[5] << 16) |
                        ((uint32_t)attr[6] << 8)  |
                        (uint32_t)attr[7];

    // RFC 5389 XOR
    uint16_t portXor = 0x2112; // top 16 bits of magic cookie 0x2112A442
    uint32_t ipXor   = 0x2112A442UL;

    uint16_t port = portRaw ^ portXor;
    uint32_t ip   = ipRaw ^ ipXor;

    char ipstr[64];
    snprintf(ipstr, sizeof(ipstr), "%u.%u.%u.%u",
             (ip >> 24) & 0xFF,
             (ip >> 16) & 0xFF,
             (ip >> 8)  & 0xFF,
             ip & 0xFF);
    out.mappedAddress = ipstr;
    out.mappedPort = port;
    return true;
}

// Parse MAPPED-ADDRESS (legacy, not XOR'd)
static bool parseMappedAddress(const uint8_t* attr, int attrLen,
                               StunBindingResponse& out)
{
    if (attrLen < 8) return false;
    uint8_t family = attr[1];
    if (family != 0x01) return false; // only IPv4

    uint16_t port = ((uint16_t)attr[2] << 8) | attr[3];
    char ipstr[64];
    snprintf(ipstr, sizeof(ipstr), "%u.%u.%u.%u",
             attr[4], attr[5], attr[6], attr[7]);
    out.mappedAddress = ipstr;
    out.mappedPort = port;
    return true;
}

StunBindingResponse StunClient::parseResponse(const void* data, int size)
{
    StunBindingResponse resp;
    if (size < 20) return resp;

    const uint8_t* p = (const uint8_t*)data;

    // Type: 0x0101 = Binding Success Response
    uint16_t type = ((uint16_t)p[0] << 8) | p[1];
    // Length
    uint16_t msgLen = ((uint16_t)p[2] << 8) | p[3];

    if (type != 0x0101) {
        // Binding Error Response
        printf("[StunClient] Received STUN error response type=0x%04x\n", type);
        return resp;
    }

    // Verify magic cookie (bytes 4-7)
    if (p[4] != 0x21 || p[5] != 0x12 || p[6] != 0xA4 || p[7] != 0x42)
        return resp;

    // Verify transaction ID (bytes 8-19)
    if (memcmp(p + 8, transactionId_, 12) != 0) {
        printf("[StunClient] Transaction ID mismatch\n");
        return resp;
    }

    // Parse attributes (start after 20-byte header)
    const uint8_t* attrStart = p + 20;
    int attrBytes = size - 20;

    while (attrBytes >= 4) {
        uint16_t attrType = ((uint16_t)attrStart[0] << 8) | attrStart[1];
        uint16_t attrLen  = ((uint16_t)attrStart[2] << 8) | attrStart[3];
        int paddedLen = (attrLen + 3) & ~3u; // 4-byte aligned

        if (attrBytes < 4 + paddedLen) break;

        if (attrType == ATTR_XOR_MAPPED_ADDRESS || attrType == ATTR_XOR_MAPPED_ADDRESS2) {
            parseXorMappedAddress(attrStart + 4, attrLen, resp);
        } else if (attrType == ATTR_MAPPED_ADDRESS) {
            parseMappedAddress(attrStart + 4, attrLen, resp);
        }

        attrStart += 4 + paddedLen;
        attrBytes -= 4 + paddedLen;
    }

    resp.success = resp.mappedAddress.isNotEmpty();
    return resp;
}

StunBindingResponse StunClient::sendAndReceive(const juce::MemoryBlock& request,
                                                int timeoutMs)
{
    StunBindingResponse resp;
    auto startTime = std::chrono::steady_clock::now();

    if (!socket_->bindToPort(0)) {
        socket_->bindToPort(0);
    }

    // Send the request
    int sent = socket_->write(server_.host, server_.port,
                               request.getData(), (int)request.getSize());
    if (sent < 0) {
        printf("[StunClient] Send failed\n");
        return resp;
    }

    // Non-blocking receive with polling
    uint8_t recvBuf[1024];
    juce::String senderIP;
    int senderPort = 0;

    while (true) {
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - startTime).count();

        if (elapsed >= timeoutMs) {
            printf("[StunClient] STUN timeout after %ldms\n", (long)elapsed);
            break;
        }

        int n = socket_->read(recvBuf, sizeof(recvBuf), false, senderIP, senderPort);
        if (n > 0) {
            resp = parseResponse(recvBuf, n);
            if (resp.success) {
                resp.responseTimeMs = (int)elapsed;
                lastResponse_ = resp;
                return resp;
            }
        }

        juce::Thread::sleep(5);
    }

    return resp;
}

StunBindingResponse StunClient::bindingRequest(int timeoutMs)
{
    if (server_.host.isEmpty()) {
        auto defaultServer = defaultStunServerFromConfig();
        server_.host = defaultServer.host;
        server_.port = defaultServer.port;
    }

    printf("[StunClient] Sending binding request to %s:%d\n",
           server_.host.toRawUTF8(), server_.port);

    auto req = buildBindingRequest();
    return sendAndReceive(req, timeoutMs);
}

NatType StunClient::detectNatType(int timeoutMs)
{
    NatType result = NatType::Unknown;

    StunServerInfo server = defaultStunServerFromConfig();
    setServer(server);

    auto resp1 = bindingRequest(timeoutMs);
    if (!resp1.success) {
        printf("[StunClient] detectNatType: STUN server unreachable\n");
        return NatType::Unknown;
    }

    printf("[StunClient] detectNatType: mapped=%s:%d\n",
           resp1.mappedAddress.toRawUTF8(), resp1.mappedPort);

    // Second binding request to check if mapping is consistent
    auto resp2 = bindingRequest(timeoutMs);
    if (resp2.success) {
        if (resp1.mappedAddress == resp2.mappedAddress &&
            resp1.mappedPort == resp2.mappedPort) {
            // Consistent mapping = not symmetric NAT
            // For a proper test we'd use a second STUN server
            // to distinguish Open vs FullCone vs Restricted
            // Simplified: if same address, assume Open or FullCone
            result = NatType::Open; // optimistic
        } else {
            // Different mapped address on same socket = Symmetric NAT
            result = NatType::Symmetric;
        }
    }

    return result;
}

bool StunClient::isReachable(int timeoutMs)
{
    auto resp = bindingRequest(timeoutMs);
    return resp.success;
}
