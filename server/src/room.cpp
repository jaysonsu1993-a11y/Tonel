#include "room.h"
#include "password_hasher.h"
#include <algorithm>
#include <iostream>

// ── Room ─────────────────────────────────────────────────────────────────────────────────

Room::Room(const std::string& id, const std::string& owner_id,
           const std::string& password_hash)
    : room_id_(id), owner_id_(owner_id), password_hash_(password_hash),
      empty_since_(std::chrono::steady_clock::now()) {}

Room::~Room() = default;

bool Room::check_password(const std::string& plaintext_pwd) const {
    if (!has_password()) return true;
    return PasswordHasher::verify_password(plaintext_pwd, password_hash_);
}

bool Room::add_user(const std::string& user_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    // v6.5.5: idempotent. We used to return `inserted` here; the only
    // caller (RoomManager::join_room) propagated that to
    // process_join_room, which surfaced "false" as
    // `make_error("Room not found")` — wildly misleading when the real
    // condition was "user already in the room".
    //
    // That can happen by design after process_join_room's session-
    // takeover path: it marks the previous ctx for the same user_id
    // as `displaced`, then short-circuits the displaced ctx's on_close
    // leave-cascade (so the live session keeps its slots). The
    // upshot: room->users_ permanently retains the old uid until the
    // new ctx successfully re-joins. With the previous non-idempotent
    // add_user, that re-join failed loudly.
    //
    // A "join" of an already-member uid is logically successful — they
    // are a member afterwards, which was the goal. Returning true
    // here also collapses an entire class of reconnect / SIGPIPE /
    // hard-quit races that all manifested as "Room not found" on the
    // user's next launch.
    users_.insert(user_id);
    return true;
}

bool Room::remove_user(const std::string& user_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    bool removed = users_.erase(user_id) > 0;
    if (removed && users_.empty()) {
        empty_since_ = std::chrono::steady_clock::now();
    }
    return removed;
}

std::chrono::steady_clock::time_point Room::empty_since() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return empty_since_;
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
    return it->second->remove_user(user_id);
}

std::vector<std::string> RoomManager::reap_idle_rooms(std::chrono::steady_clock::duration max_idle) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto now = std::chrono::steady_clock::now();
    std::vector<std::string> reaped;
    for (auto it = rooms_.begin(); it != rooms_.end(); ) {
        if (it->second->user_count() == 0 && (now - it->second->empty_since()) >= max_idle) {
            reaped.push_back(it->first);
            it = rooms_.erase(it);
        } else {
            ++it;
        }
    }
    return reaped;
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
