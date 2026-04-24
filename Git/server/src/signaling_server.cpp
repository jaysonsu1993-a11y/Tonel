#include "signaling_server.h"
#include "password_hasher.h"
#include <iostream>
#include <cstring>
#include <sstream>
#include <regex>

ClientContext::ClientContext(SignalingServer* srv) : server(srv) {}

// ============================================================
// SimpleJson - minimal JSON parser for our protocol
// ============================================================
struct SimpleJson {
    std::string type;
    std::string room_id;
    std::string user_id;
    std::string password;
    std::string ip;
    int port = 0;
    std::vector<std::string> users;
    std::string message;

    static SimpleJson parse(const std::string& str) {
        SimpleJson j;
        j.type = extract(str, "type");
        j.room_id = extract(str, "room_id");
        j.user_id = extract(str, "user_id");
        j.password = extract(str, "password");
        j.message = extract(str, "message");
        j.ip = extract(str, "ip");
        j.port = extract_int(str, "port");

        size_t users_start = str.find("\"users\"");
        if (users_start != std::string::npos) {
            size_t bracket_start = str.find('[', users_start);
            size_t bracket_end = str.find(']', bracket_start);
            if (bracket_start != std::string::npos && bracket_end != std::string::npos) {
                std::string arr = str.substr(bracket_start + 1, bracket_end - bracket_start - 1);
                std::stringstream ss(arr);
                std::string item;
                while (std::getline(ss, item, ',')) {
                    item.erase(std::remove_if(item.begin(), item.end(), ::isspace), item.end());
                    item.erase(std::remove(item.begin(), item.end(), '"'), item.end());
                    if (!item.empty()) j.users.push_back(item);
                }
            }
        }
        return j;
    }

    static std::string extract(const std::string& str, const std::string& key) {
        std::string pattern = "\"" + key + "\"\\s*:\\s*\"([^\"]*)\"";
        std::regex re(pattern);
        std::smatch match;
        if (std::regex_search(str, match, re)) return match[1].str();
        return "";
    }

    static int extract_int(const std::string& str, const std::string& key) {
        std::string pattern = "\"" + key + "\"\\s*:\\s*(\\d+)";
        std::regex re(pattern);
        std::smatch match;
        if (std::regex_search(str, match, re)) return std::stoi(match[1].str());
        return 0;
    }

    static std::string json_escape(const std::string& s) {
        std::string r;
        r.reserve(s.size());
        for (char c : s) {
            if (c == '"')  r += "\\\"";
            else if (c == '\\') r += "\\\\";
            else if (c == '\n') r += "\\n";
            else if (c == '\r') r += "\\r";
            else if (c == '\t') r += "\\t";
            else r += c;
        }
        return r;
    }

    static std::string make_user_list(const std::string& room_id, const std::vector<std::string>& users) {
        std::string arr = "[";
        for (size_t i = 0; i < users.size(); ++i) {
            arr += "\"" + json_escape(users[i]) + "\"";
            if (i < users.size() - 1) arr += ",";
        }
        arr += "]";
        return "{\"type\":\"USER_LIST\",\"room_id\":\"" + room_id + "\",\"users\":" + arr + "}";
    }

    // Build PEER_LIST with full user_id, ip, port info (sent to joining client)
    static std::string make_peer_list(
        const std::string& room_id,
        const std::vector<std::tuple<std::string, std::string, int>>& peers) {
        std::string arr = "[";
        for (size_t i = 0; i < peers.size(); ++i) {
            arr += "{\"user_id\":\"" + json_escape(std::get<0>(peers[i])) + "\","
                   "\"ip\":\"" + json_escape(std::get<1>(peers[i])) + "\","
                   "\"port\":" + std::to_string(std::get<2>(peers[i])) + "}";
            if (i < peers.size() - 1) arr += ",";
        }
        arr += "]";
        return "{\"type\":\"PEER_LIST\",\"room_id\":\"" + room_id + "\",\"peers\":" + arr + "}";
    }

    // Build PEER_JOINED broadcast when a new peer joins (sent to existing peers)
    static std::string make_peer_joined(const std::string& room_id,
                                        const std::string& user_id,
                                        const std::string& ip,
                                        int port) {
        return "{\"type\":\"PEER_JOINED\",\"room_id\":\"" + room_id + "\","
               "\"user_id\":\"" + json_escape(user_id) + "\","
               "\"ip\":\"" + json_escape(ip) + "\","
               "\"port\":" + std::to_string(port) + "}";
    }

    static std::string make_error(const std::string& msg) {
        return "{\"type\":\"ERROR\",\"message\":\"" + msg + "\"}";
    }

    static std::string make_room_list(const std::vector<std::string>& room_ids) {
        std::string arr = "[";
        for (size_t i = 0; i < room_ids.size(); ++i) {
            arr += "\"" + room_ids[i] + "\"";
            if (i < room_ids.size() - 1) arr += ",";
        }
        arr += "]";
        return "{\"type\":\"ROOM_LIST\",\"rooms\":" + arr + "}";
    }

    static std::string make_ack(const std::string& type, const std::string& room_id = "") {
        if (room_id.empty())
            return "{\"type\":\"" + type + "_ACK\"}";
        return "{\"type\":\"" + type + "_ACK\",\"room_id\":\"" + room_id + "\"}";
    }
};

// ============================================================
// SignalingServer
// ============================================================

SignalingServer::SignalingServer(uv_loop_t* loop, int port)
    : loop_(loop), port_(port) {
    uv_tcp_init(loop, &server_);
    server_.data = this;
}

SignalingServer::~SignalingServer() = default;

void SignalingServer::start() {
    user_manager_.set_on_user_remove([](const std::string&, uv_tcp_t* client) {
        // Guard against double-close: if on_read already initiated close, skip
        if (!uv_is_closing((uv_handle_t*)client)) {
            uv_close((uv_handle_t*)client, on_close);
        }
    });

    struct sockaddr_in addr;
    uv_ip4_addr("0.0.0.0", port_, &addr);
    uv_tcp_bind(&server_, (const struct sockaddr*)&addr, 0);

    int r = uv_listen((uv_stream_t*)&server_, 128, on_new_connection);
    if (r < 0) {
        std::cerr << "Listen error: " << uv_strerror(r) << std::endl;
        return;
    }
    std::cout << "SignalingServer listening on port " << port_ << std::endl;

    uv_timer_init(loop_, &heartbeat_timer_);
    heartbeat_timer_.data = this;
    uv_timer_start(&heartbeat_timer_, on_heartbeat_timer, 30000, 30000);

    // Reap idle (empty) rooms every 5 minutes
    uv_timer_init(loop_, &room_reaper_timer_);
    room_reaper_timer_.data = this;
    uv_timer_start(&room_reaper_timer_, on_room_reaper_timer, 300000, 300000);
}

void SignalingServer::broadcast_to_room(const std::string& room_id,
                                         const std::string& json_msg,
                                         const std::string& exclude_user) {
    Room* room = room_manager_.get_room(room_id);
    if (!room) return;
    auto users = room->get_users();
    for (const auto& uid : users) {
        if (!exclude_user.empty() && uid == exclude_user) continue;
        User* user = user_manager_.get_user(uid);
        if (user && user->client) {
            send_response((uv_stream_t*)user->client, json_msg);
        }
    }
}

void SignalingServer::send_response(uv_stream_t* client, const std::string& json_msg) {
    if (!client) return;
    std::string* msg_heap = new std::string(json_msg + "\n");
    uv_buf_t buf = uv_buf_init(const_cast<char*>(msg_heap->c_str()), msg_heap->size());
    uv_write_t* req = new uv_write_t;
    req->data = msg_heap;
    int r = uv_write(req, client, &buf, 1, [](uv_write_t* req, int) {
        delete static_cast<std::string*>(req->data);
        delete req;
    });
    if (r < 0) {
        delete msg_heap;
        delete req;
    }
}

// ============================================================
// libuv callbacks
// ============================================================

void SignalingServer::on_new_connection(uv_stream_t* server, int status) {
    auto* self = static_cast<SignalingServer*>(server->data);
    self->handle_new_connection(server, status);
}

void SignalingServer::on_alloc_buffer(uv_handle_t*, size_t, uv_buf_t* buf) {
    buf->base = new char[4096];
    buf->len = 4096;
}

void SignalingServer::on_read(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {
    auto* ctx = static_cast<ClientContext*>(stream->data);
    if (!ctx || !ctx->server) {
        if (buf->base) delete[] buf->base;
        return;
    }
    ctx->server->handle_read(stream, nread, buf);

    if (nread < 0) {
        // Guard against double-close: check uv_is_closing instead of nulling
        // stream->data (nulling it would cause on_close to leak the ClientContext)
        if (!uv_is_closing((uv_handle_t*)stream)) {
            uv_close((uv_handle_t*)stream, on_close);
        }
        if (buf->base) delete[] buf->base;
        return;
    }
}

void SignalingServer::on_close(uv_handle_t* handle) {
    auto* ctx = static_cast<ClientContext*>(handle->data);
    handle->data = nullptr;
    if (!ctx || !ctx->server) {
        delete ctx;
        return;
    }
    SignalingServer* server = ctx->server;
    // If the disconnecting client is the mixer proxy, clear the reference
    if (server->mixer_ctx_ == ctx) {
        server->mixer_ctx_ = nullptr;
        std::cout << "[Mixer] WebRTC mixer proxy disconnected" << std::endl;
    }
    std::string uid = ctx->user_id;
    if (!uid.empty()) {
        // Collect rooms first (get_all_rooms snapshot before we start mutating)
        std::vector<std::string> room_ids;
        for (auto* room : server->room_manager_.get_all_rooms()) {
            if (room->has_user(uid)) room_ids.push_back(room->room_id());
        }
        for (const auto& rid : room_ids) {
            // Broadcast PEER_LEFT before removing so remaining members are notified
            std::string msg = "{\"type\":\"PEER_LEFT\",\"room_id\":\"" + rid
                            + "\",\"user_id\":\"" + SimpleJson::json_escape(uid) + "\"}";
            server->broadcast_to_room(rid, msg, uid);
            server->room_manager_.leave_room(rid, uid);
        }
        {
            std::lock_guard<std::mutex> lock(server->client_map_mutex_);
            server->user_id_to_ctx_.erase(uid);
        }
        server->user_manager_.remove_user_no_close(uid);
    }
    delete ctx;
}

void SignalingServer::on_heartbeat_timer(uv_timer_t* handle) {
    static_cast<SignalingServer*>(handle->data)->user_manager_.check_timeouts();
}

void SignalingServer::on_room_reaper_timer(uv_timer_t* handle) {
    auto* self = static_cast<SignalingServer*>(handle->data);
    auto reaped = self->room_manager_.reap_idle_rooms(std::chrono::minutes(30));
    for (const auto& rid : reaped) {
        std::cout << "[Room] Room " << rid << " reaped (idle >30min)" << std::endl;
    }
}

// ============================================================
// Connection handling
// ============================================================

void SignalingServer::handle_new_connection(uv_stream_t* server, int status) {
    if (status < 0) {
        std::cerr << "New connection error: " << uv_strerror(status) << std::endl;
        return;
    }
    auto* ctx = new ClientContext(this);
    int r = uv_tcp_init(loop_, &ctx->tcp_handle);
    if (r < 0) { delete ctx; return; }
    ctx->tcp_handle.data = ctx;

    if (uv_accept(server, (uv_stream_t*)&ctx->tcp_handle) == 0) {
        uv_read_start((uv_stream_t*)&ctx->tcp_handle, on_alloc_buffer, on_read);
    } else {
        uv_close((uv_handle_t*)&ctx->tcp_handle, [](uv_handle_t* handle) {
            auto* ctx = static_cast<ClientContext*>(handle->data);
            delete ctx;
        });
    }
}

void SignalingServer::handle_read(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {
    if (nread < 0) {
        // Buffer will be freed by on_read; uv_close is also called there.
        return;
    }
    if (nread == 0 || !buf->base) {
        if (buf->base) delete[] buf->base;
        return;
    }

    std::string data(buf->base, nread);
    delete[] buf->base;

    size_t start = 0;
    while (start < data.size()) {
        size_t pos = data.find('\n', start);
        if (pos == std::string::npos) break;
        std::string msg = data.substr(start, pos - start);
        start = pos + 1;
        if (!msg.empty()) handle_message(stream, msg);
    }
}

void SignalingServer::handle_message(uv_stream_t* client, const std::string& msg) {
    if (msg.size() > 8192) {
        send_response(client, SimpleJson::make_error("message too long"));
        return;
    }
    auto j = SimpleJson::parse(msg);
    if (j.type == "CREATE_ROOM")      process_create_room(client, j.room_id, j.user_id, j.password);
    else if (j.type == "JOIN_ROOM")   process_join_room(client, j.room_id, j.user_id, j.password, j.ip, j.port);
    else if (j.type == "LEAVE_ROOM")  process_leave_room(client, j.room_id, j.user_id);
    else if (j.type == "LIST_ROOMS")  process_list_rooms(client);
    else if (j.type == "HEARTBEAT")   process_heartbeat(client, j.user_id);
    // ── WebRTC mixer proxy relay ────────────────────────────────
    else if (j.type == "MIXER_REGISTER") {
        // The webrtc-mixer-proxy registers itself so we know where to relay offers
        auto* ctx = static_cast<ClientContext*>(client->data);
        if (ctx) {
            ctx->user_id = "__mixer__";
            mixer_ctx_ = ctx;
        }
        send_response(client, "{\"type\":\"MIXER_REGISTER_ACK\"}");
        std::cout << "[Mixer] WebRTC mixer proxy registered" << std::endl;
    }
    else if (j.type == "MIXER_OFFER" || j.type == "MIXER_ICE") {
        // From browser → forward raw message to mixer proxy
        if (mixer_ctx_) {
            send_response((uv_stream_t*)&mixer_ctx_->tcp_handle, msg);
        } else {
            send_response(client, SimpleJson::make_error("Mixer proxy not connected"));
        }
    }
    else if (j.type == "MIXER_ANSWER" || j.type == "MIXER_ICE_RELAY") {
        // From mixer proxy → forward to target browser client
        std::string target = SimpleJson::extract(msg, "target_user_id");
        if (!target.empty()) {
            std::lock_guard<std::mutex> lock(client_map_mutex_);
            auto it = user_id_to_ctx_.find(target);
            if (it != user_id_to_ctx_.end()) {
                send_response((uv_stream_t*)&it->second->tcp_handle, msg);
            }
        }
    }
    else send_response(client, SimpleJson::make_error("Unknown message type: " + j.type));
}

// ============================================================
// Message handlers
// ============================================================

void SignalingServer::process_create_room(uv_stream_t* client,
                                           const std::string& room_id,
                                           const std::string& user_id,
                                           const std::string& password) {
    if (room_id.empty() || user_id.empty()) {
        send_response(client, SimpleJson::make_error("room_id and user_id required"));
        return;
    }
    // P0-5: sanitize user_id — length limit and basic injection prevention
    if (user_id.size() > 64) {
        send_response(client, SimpleJson::make_error("user_id too long"));
        return;
    }
    auto* ctx = static_cast<ClientContext*>(client->data);
    if (ctx) ctx->user_id = SimpleJson::json_escape(user_id);

    auto user = std::make_unique<User>(user_id, &ctx->tcp_handle);
    user_manager_.add_user(std::move(user));
    {
        std::lock_guard<std::mutex> lock(client_map_mutex_);
        user_id_to_ctx_[user_id] = ctx;
    }

    Room* room = room_manager_.create_room(room_id, user_id,
        password.empty() ? "" : PasswordHasher::hash_password(password));
    if (!room) {
        send_response(client, SimpleJson::make_error("Room already exists"));
        return;
    }
    send_response(client, SimpleJson::make_ack("CREATE_ROOM", room_id));
    std::cout << "[Room] Created: " << room_id << " by " << user_id
              << (password.empty() ? " (no password)" : " (password protected)") << std::endl;
}

void SignalingServer::process_join_room(uv_stream_t* client,
                                        const std::string& room_id,
                                        const std::string& user_id,
                                        const std::string& password,
                                        const std::string& ip,
                                        int port) {
    if (room_id.empty() || user_id.empty()) {
        send_response(client, SimpleJson::make_error("room_id and user_id required"));
        return;
    }
    // P0-5: sanitize user_id — length limit and basic injection prevention
    if (user_id.size() > 64) {
        send_response(client, SimpleJson::make_error("user_id too long"));
        return;
    }
    auto* ctx = static_cast<ClientContext*>(client->data);
    if (ctx) ctx->user_id = SimpleJson::json_escape(user_id);

    // Store or update user with their P2P address info
    User* existingUser = user_manager_.get_user(user_id);
    if (!existingUser) {
        auto user = std::make_unique<User>(user_id, &ctx->tcp_handle);
        user->ip = ip;
        user->udp_port = port;
        user_manager_.add_user(std::move(user));
    } else {
        existingUser->client = &ctx->tcp_handle;
        existingUser->ip = ip;
        existingUser->udp_port = port;
    }
    {
        std::lock_guard<std::mutex> lock(client_map_mutex_);
        user_id_to_ctx_[user_id] = ctx;
    }

    // Verify password if room is password-protected
    Room* room = room_manager_.get_room(room_id);
    if (!room) {
        send_response(client, SimpleJson::make_error("Room not found"));
        return;
    }
    if (room->has_password() && !room->check_password(password)) {
        send_response(client, SimpleJson::make_error("Incorrect room password"));
        return;
    }

    if (!room_manager_.join_room(room_id, user_id)) {
        send_response(client, SimpleJson::make_error("Room not found"));
        return;
    }
    send_response(client, SimpleJson::make_ack("JOIN_ROOM", room_id));

    // Send PEER_LIST to the joining client — all existing peers with their P2P addresses
    if (room) {
        auto users = room->get_users();
        std::vector<std::tuple<std::string, std::string, int>> peerInfos;
        for (const auto& uid : users) {
            if (uid == user_id) continue; // exclude self
            User* u = user_manager_.get_user(uid);
            if (u) {
                peerInfos.emplace_back(u->user_id, u->ip, u->udp_port);
            }
        }
        if (!peerInfos.empty()) {
            send_response(client, SimpleJson::make_peer_list(room_id, peerInfos));
        }

        // Broadcast PEER_JOINED to all existing peers so they can punch-hole to the new peer
        if (!ip.empty() && port > 0) {
            auto joinedMsg = SimpleJson::make_peer_joined(room_id, user_id, ip, port);
            broadcast_to_room(room_id, joinedMsg, user_id);
        }
    }
    std::cout << "[Room] " << user_id << " joined " << room_id
              << " (P2P: " << ip << ":" << port << ")" << std::endl;
}

void SignalingServer::process_leave_room(uv_stream_t* client,
                                          const std::string& room_id,
                                          const std::string& user_id) {
    if (room_id.empty() || user_id.empty()) {
        send_response(client, SimpleJson::make_error("room_id and user_id required"));
        return;
    }
    // P0-5: sanitize user_id — length limit and basic injection prevention
    if (user_id.size() > 64) {
        send_response(client, SimpleJson::make_error("user_id too long"));
        return;
    }
    // Broadcast PEER_LEFT before removing from room so remaining members are notified
    std::string peerLeftMsg = "{\"type\":\"PEER_LEFT\",\"room_id\":\"" + room_id
                            + "\",\"user_id\":\"" + SimpleJson::json_escape(user_id) + "\"}";
    broadcast_to_room(room_id, peerLeftMsg, user_id);

    room_manager_.leave_room(room_id, user_id);
    {
        std::lock_guard<std::mutex> lock(client_map_mutex_);
        user_id_to_ctx_.erase(user_id);
    }
    // Remove from UserManager NOW — if we defer to on_close, check_timeouts may
    // fire first (within 30 s) and call uv_close on a handle already being closed
    // by on_read, causing a double-close crash.
    user_manager_.remove_user_no_close(user_id);
    // Clear ctx->user_id so on_close skips redundant cleanup for this user
    auto* ctx = static_cast<ClientContext*>(client->data);
    if (ctx) ctx->user_id.clear();

    send_response(client, SimpleJson::make_ack("LEAVE_ROOM"));
    std::cout << "[Room] " << user_id << " left " << room_id << std::endl;
}

void SignalingServer::process_list_rooms(uv_stream_t* client) {
    auto rooms = room_manager_.get_all_rooms();
    std::vector<std::string> ids;
    for (auto r : rooms) ids.push_back(r->room_id());
    send_response(client, SimpleJson::make_room_list(ids));
}

void SignalingServer::process_heartbeat(uv_stream_t* client, const std::string& user_id) {
    if (!user_id.empty()) user_manager_.update_heartbeat(user_id);
    send_response(client, "{\"type\":\"HEARTBEAT_ACK\"}");
}
