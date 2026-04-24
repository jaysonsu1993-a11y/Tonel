#include "user.h"
#include <algorithm>
#include <chrono>

void UserManager::add_user(std::unique_ptr<User> user) {
    std::lock_guard<std::mutex> lock(mutex_);
    users_[user->user_id] = std::move(user);
}

void UserManager::remove_user(const std::string& user_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    users_.erase(user_id);
}

void UserManager::remove_user_no_close(const std::string& user_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    users_.erase(user_id);
}

User* UserManager::get_user(const std::string& user_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = users_.find(user_id);
    if (it != users_.end()) {
        return it->second.get();
    }
    return nullptr;
}

std::vector<User*> UserManager::get_all_users() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<User*> result;
    for (auto& pair : users_) {
        result.push_back(pair.second.get());
    }
    return result;
}

void UserManager::update_heartbeat(const std::string& user_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = users_.find(user_id);
    if (it != users_.end()) {
        it->second->last_heartbeat = std::chrono::steady_clock::now();
        it->second->is_alive = true;
    }
}

void UserManager::check_timeouts() {
    std::lock_guard<std::mutex> lock(mutex_);
    auto now = std::chrono::steady_clock::now();
    constexpr auto TIMEOUT = std::chrono::seconds(90);
    std::vector<std::string> to_remove;
    for (auto& pair : users_) {
        if (now - pair.second->last_heartbeat > TIMEOUT) {
            pair.second->is_alive = false;
            to_remove.push_back(pair.first);
        }
    }
    for (const auto& uid : to_remove) {
        auto it = users_.find(uid);
        if (it != users_.end()) {
            uv_tcp_t* client = it->second->client;
            users_.erase(it);  // erase before callback to prevent double-close on next timer tick
            if (client && on_user_remove_) {
                on_user_remove_(uid, client);
            }
        }
    }
}
