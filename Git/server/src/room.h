#pragma once

#include <string>
#include <vector>
#include <set>
#include <unordered_map>
#include <memory>
#include <mutex>

struct User;

class Room {
public:
    Room(const std::string& id, const std::string& owner_id, const std::string& password_hash = "");
    ~Room();

    const std::string& room_id() const { return room_id_; }
    const std::string& owner_id() const { return owner_id_; }
    bool has_password() const { return !password_hash_.empty(); }
    bool check_password(const std::string& plaintext_pwd) const;

    bool add_user(const std::string& user_id);
    bool remove_user(const std::string& user_id);
    std::vector<std::string> get_users() const;
    bool has_user(const std::string& user_id) const;
    size_t user_count() const;

private:
    std::string room_id_;
    std::string owner_id_;
    std::string password_hash_;
    std::set<std::string> users_;
    mutable std::mutex mutex_;
};

class RoomManager {
public:
    Room* create_room(const std::string& room_id, const std::string& owner_id, const std::string& password = "");
    bool destroy_room(const std::string& room_id);
    Room* get_room(const std::string& room_id);
    bool join_room(const std::string& room_id, const std::string& user_id);
    bool leave_room(const std::string& room_id, const std::string& user_id);
    std::vector<Room*> get_all_rooms();

private:
    std::unordered_map<std::string, std::unique_ptr<Room>> rooms_;
    std::mutex mutex_;
};
