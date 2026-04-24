#include "room.h"
#include "password_hasher.h"
#include <algorithm>
#include <iostream>

// ── Room ─────────────────────────────────────────────────────────────────────────────────

Room::Room(const std::string& id, const std::string& owner_id,
           const std::string& password_hash)
    : room_id_(id), owner_id_(owner_id), password_hash_(password_hash) {}

Room::~Room() = default;

bool Room::check_password(const std::string& plaintext_pwd) const {
    if (!has_password()) return true;
    return PasswordHasher::verify_password(plaintext_pwd, password_hash_);
}

bool Room::add_user(const std::string& user_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto [it, inserted] = users_.insert(user_id);
    return inserted;
}

bool Room::remove_user(const std::string& user_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    return users_.erase(user_id) > 0;
}

std::vector<std::string> Room::get_users() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return std::vector<std::string>(users_.begin(), users_.end());
}

bool Room::has_user(const std::string& user_id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return users_.count(user_id) > 0;
}

size_t Room::user_count() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return users_.size();
}

// ── RoomManager ──────────────────────────────────────────────────────────────────────────────────

Room* RoomManager::create_room(const std::string& room_id,
                               const std::string& owner_id,
                               const std::string& password_hash) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (rooms_.count(room_id)) return nullptr;
    auto room = std::make_unique<Room>(room_id, owner_id, password_hash);
    Room* ptr = room.get();
    rooms_[room_id] = std::move(room);
    return ptr;
}

bool RoomManager::destroy_room(const std::string& room_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    return rooms_.erase(room_id) > 0;
}

Room* RoomManager::get_room(const std::string& room_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(room_id);
    if (it != rooms_.end()) return it->second.get();
    return nullptr;
}

bool RoomManager::join_room(const std::string& room_id,
                            const std::string& user_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(room_id);
    if (it == rooms_.end()) return false;
    return it->second->add_user(user_id);
}

bool RoomManager::leave_room(const std::string& room_id,
                             const std::string& user_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = rooms_.find(room_id);
    if (it == rooms_.end()) return false;
    bool removed = it->second->remove_user(user_id);
    // 如果房间为空，销毁房间
    if (removed && it->second->user_count() == 0) {
        rooms_.erase(it);
        std::cout << "[Room] Room " << room_id << " destroyed (empty)" << std::endl;
    }
    return removed;
}

std::vector<Room*> RoomManager::get_all_rooms() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<Room*> result;
    result.reserve(rooms_.size());
    for (auto& [id, room] : rooms_) {
        result.push_back(room.get());
    }
    return result;
}
