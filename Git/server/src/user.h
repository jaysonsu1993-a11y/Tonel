#pragma once

#include <string>
#include <chrono>
#include <memory>
#include <vector>
#include <unordered_map>
#include <mutex>
#include <functional>
#include <uv.h>

struct User {
    std::string user_id;
    std::string room_id;
    std::string ip;        // Client's advertised IP for P2P
    int udp_port = 0;      // Client's UDP listen port for P2P
    uv_tcp_t* client;
    std::chrono::steady_clock::time_point last_heartbeat;
    bool is_alive;

    User(const std::string& id, uv_tcp_t* cli)
        : user_id(id), client(cli), last_heartbeat(std::chrono::steady_clock::now()), is_alive(true) {}
};

class UserManager {
public:
    void set_on_user_remove(std::function<void(const std::string&, uv_tcp_t*)> cb) {
        on_user_remove_ = std::move(cb);
    }
    void add_user(std::unique_ptr<User> user);
    void remove_user(const std::string& user_id);
    void remove_user_no_close(const std::string& user_id);  // remove without triggering uv_close callback
    User* get_user(const std::string& user_id);
    std::vector<User*> get_all_users();
    void update_heartbeat(const std::string& user_id);
    void check_timeouts();

private:
    // Called when a user is removed (timeout); closes the connection.
    // Signature: void(const std::string& user_id, uv_tcp_t* client)
    std::function<void(const std::string&, uv_tcp_t*)> on_user_remove_;
    std::unordered_map<std::string, std::unique_ptr<User>> users_;
    std::mutex mutex_;
};
