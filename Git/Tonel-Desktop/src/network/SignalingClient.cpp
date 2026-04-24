// SignalingClient.cpp - TCP signaling client implementation
#include "SignalingClient.h"
#include <iostream>

SignalingClient::SignalingClient() = default;

SignalingClient::~SignalingClient() {
    disconnect();
}

bool SignalingClient::connect(const std::string& host, int port) {
    if (running_.load()) {
        printf("[Signaling] already connected\n");
        return true;
    }

    serverHost_ = host;
    serverPort_ = port;

    socket_ = std::make_unique<juce::StreamingSocket>();
    if (!socket_->connect(host, port, 5000)) {
        printf("[Signaling] connect to %s:%d FAILED\n", host.c_str(), port);
        socket_.reset();
        if (callback_) callback_->onSignalingError("Connection failed");
        return false;
    }

    printf("[Signaling] connected to %s:%d\n", host.c_str(), port);
    connected_.store(true, std::memory_order_release);
    running_.store(true, std::memory_order_release);

    receiveThread_ = std::thread(&SignalingClient::receiveThreadFunc, this);
    return true;
}

void SignalingClient::disconnect() {
    if (!running_.load())
        return;

    running_.store(false, std::memory_order_release);
    connected_.store(false, std::memory_order_release);

    if (socket_) {
        socket_->close();
        socket_.reset();
    }

    if (receiveThread_.joinable())
        receiveThread_.join();

    printf("[Signaling] disconnected\n");
}

void SignalingClient::createRoom(const std::string& roomId, const std::string& userId, const std::string& password) {
    if (!connected_.load()) {
        printf("[Signaling] not connected, cannot create room\n");
        return;
    }
    std::string msg = "{\"type\":\"CREATE_ROOM\",\"room_id\":\"" + roomId +
                      "\",\"user_id\":\"" + userId +
                      "\",\"password\":\"" + password + "\"}";
    printf("[Signaling] CREATE_ROOM: %s\n", msg.c_str());
    send(msg);
}

void SignalingClient::joinRoom(const std::string& roomId, const std::string& userId,
                               const std::string& password,
                               const std::string& localIp, int localPort) {
    if (!connected_.load()) {
        printf("[Signaling] not connected, cannot join room\n");
        return;
    }
    std::string msg = "{\"type\":\"JOIN_ROOM\",\"room_id\":\"" + roomId +
                      "\",\"user_id\":\"" + userId +
                      "\",\"password\":\"" + password +
                      "\",\"ip\":\"" + localIp + "\",\"port\":" +
                      std::to_string(localPort) + "}";
    printf("[Signaling] JOIN_ROOM: %s\n", msg.c_str());
    send(msg);
}

void SignalingClient::leaveRoom(const std::string& roomId, const std::string& userId) {
    if (!connected_.load()) return;
    std::string msg = "{\"type\":\"LEAVE_ROOM\",\"room_id\":\"" + roomId +
                      "\",\"user_id\":\"" + userId + "\"}";
    send(msg);
}

void SignalingClient::send(const std::string& msg) {
    if (socket_ && socket_->isConnected()) {
        socket_->write(msg.c_str(), (int)msg.length());
    }
}

void SignalingClient::receiveThreadFunc() {
    char buffer[4096];
    std::string recvBuf;

    while (running_.load()) {
        if (!socket_ || !socket_->isConnected()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
        }

        int n = socket_->read(buffer, sizeof(buffer) - 1, false);
        if (n > 0) {
            buffer[n] = '\0';
            recvBuf.append(buffer);

            // Split by newline
            size_t pos;
            while ((pos = recvBuf.find('\n')) != std::string::npos) {
                std::string line = recvBuf.substr(0, pos);
                recvBuf.erase(0, pos + 1);
                if (!line.empty()) {
                    processLine(line);
                }
            }
        } else if (n == 0) {
            // Connection closed — process remaining buffered data before exiting
            printf("[Signaling] server closed connection, draining %zu bytes\n", recvBuf.size());
            size_t pos;
            while ((pos = recvBuf.find('\n')) != std::string::npos) {
                std::string line = recvBuf.substr(0, pos);
                recvBuf.erase(0, pos + 1);
                if (!line.empty()) {
                    processLine(line);
                }
            }
            // Process any remaining data without newline as well
            if (!recvBuf.empty()) {
                processLine(recvBuf);
                recvBuf.clear();
            }
            break;
        } else {
            // Would block, sleep a bit
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
    }

    connected_.store(false, std::memory_order_release);
    if (callback_) callback_->onSignalingDisconnected();
}

void SignalingClient::processLine(const std::string& line) {
    printf("[Signaling] recv: %s\n", line.c_str());
    auto msg = parseMessage(line);

    switch (msg.type) {
        case SignalMessage::Type::CREATE_ROOM_ACK:
            if (callback_) callback_->onRoomCreated(msg.room_id);
            break;
        case SignalMessage::Type::JOIN_ROOM_ACK:
            if (callback_) callback_->onRoomJoined(msg.room_id);
            break;
        case SignalMessage::Type::PEER_LIST:
            if (callback_) callback_->onPeerList(msg.room_id, msg.peers);
            break;
        case SignalMessage::Type::PEER_JOINED:
            if (callback_ && !msg.user_id.empty()) {
                SignalingPeerInfo p;
                p.user_id = msg.user_id;
                p.ip = extract(line, "ip");
                p.port = extractInt(line, "port");
                callback_->onPeerJoined(p);
            }
            break;
        case SignalMessage::Type::PEER_LEFT:
            if (callback_) callback_->onPeerLeft(msg.user_id);
            break;
        case SignalMessage::Type::ERROR:
            if (callback_) callback_->onSignalingError(msg.room_id, msg.message);
            break;
        default:
            break;
    }
}

SignalMessage SignalingClient::parseMessage(const std::string& json) const {
    SignalMessage m;
    m.type = SignalMessage::Type::Unknown;

    std::string type = extract(json, "type");
    if (type == "CREATE_ROOM_ACK") m.type = SignalMessage::Type::CREATE_ROOM_ACK;
    else if (type == "JOIN_ROOM_ACK") m.type = SignalMessage::Type::JOIN_ROOM_ACK;
    else if (type == "PEER_LIST") m.type = SignalMessage::Type::PEER_LIST;
    else if (type == "PEER_JOINED") m.type = SignalMessage::Type::PEER_JOINED;
    else if (type == "PEER_LEFT") m.type = SignalMessage::Type::PEER_LEFT;
    else if (type == "ROOM_LIST") m.type = SignalMessage::Type::ROOM_LIST;
    else if (type == "ERROR") m.type = SignalMessage::Type::ERROR;

    m.room_id = extract(json, "room_id");
    m.user_id = extract(json, "user_id");
    m.message = extract(json, "message");

    // Parse PEER_LIST peers array
    if (m.type == SignalMessage::Type::PEER_LIST) {
        size_t peers_start = json.find("\"peers\"");
        if (peers_start != std::string::npos) {
            size_t bracket_start = json.find('[', peers_start);
            size_t bracket_end = json.find(']', bracket_start);
            if (bracket_start != std::string::npos && bracket_end != std::string::npos) {
                std::string arr = json.substr(bracket_start + 1, bracket_end - bracket_start - 1);
                size_t pos = 0;
                while (pos < arr.size()) {
                    size_t obj_start = arr.find('{', pos);
                    if (obj_start == std::string::npos || obj_start >= bracket_end) break;
                    size_t obj_end = arr.find('}', obj_start);
                    if (obj_end == std::string::npos) break;
                    std::string obj = arr.substr(obj_start, obj_end - obj_start + 1);
                    SignalingPeerInfo p;
                    p.user_id = extract(obj, "user_id");
                    p.ip = extract(obj, "ip");
                    p.port = extractInt(obj, "port");
                    if (!p.user_id.empty()) m.peers.push_back(p);
                    pos = obj_end + 1;
                }
            }
        }
    }

    return m;
}

// Minimal JSON extract — finds "key": "value" or "key": number
std::string SignalingClient::extract(const std::string& json, const std::string& key) const {
    std::string search = "\"" + key + "\"";
    size_t kp = json.find(search);
    if (kp == std::string::npos) return "";
    size_t vp = json.find(':', kp);
    if (vp == std::string::npos) return "";
    ++vp;
    while (vp < json.size() && json[vp] == ' ') ++vp;
    if (vp >= json.size()) return "";
    if (json[vp] == '"') {
        ++vp;
        size_t end = json.find('"', vp);
        if (end == std::string::npos || end < vp) return "";
        return json.substr(vp, end - vp);
    }
    // Number
    size_t end = vp;
    while (end < json.size() && (json[end] == '-' || (json[end] >= '0' && json[end] <= '9'))) ++end;
    if (end == vp) return "";
    return json.substr(vp, end - vp);
}

int SignalingClient::extractInt(const std::string& json, const std::string& key) const {
    std::string v = extract(json, key);
    if (v.empty()) return 0;
    try { return std::stoi(v); }
    catch (...) { return 0; }
}
