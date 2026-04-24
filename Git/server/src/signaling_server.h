#pragma once

#include <uv.h>
#include <memory>
#include <string>
#include <vector>
#include <unordered_map>
#include <mutex>
#include "user.h"
#include "room.h"

class SignalingServer;

// Per-client context (lifecycle tied to the TCP connection)
struct ClientContext {
    SignalingServer* server;
    std::string user_id;
    uv_tcp_t tcp_handle;
    explicit ClientContext(SignalingServer* srv);
};

class SignalingServer {
public:
    SignalingServer(uv_loop_t* loop, int port);
    ~SignalingServer();

    void start();
    void broadcast_to_room(const std::string& room_id, const std::string& json_msg, const std::string& exclude_user = "");

    UserManager& user_manager() { return user_manager_; }
    RoomManager& room_manager() { return room_manager_; }
    uv_loop_t* loop() { return loop_; }

private:
    // libuv callbacks
    static void on_new_connection(uv_stream_t* server, int status);
    static void on_alloc_buffer(uv_handle_t* handle, size_t suggested_size, uv_buf_t* buf);
    static void on_read(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf);
    static void on_close(uv_handle_t* handle);
    static void on_heartbeat_timer(uv_timer_t* handle);
    static void on_room_reaper_timer(uv_timer_t* handle);

    void handle_new_connection(uv_stream_t* server, int status);
    void handle_read(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf);
    void handle_message(uv_stream_t* client, const std::string& msg);
    void send_response(uv_stream_t* client, const std::string& json_msg);

    void process_create_room(uv_stream_t* client, const std::string& room_id, const std::string& user_id, const std::string& password);
    void process_join_room(uv_stream_t* client, const std::string& room_id,
                              const std::string& user_id, const std::string& password, const std::string& ip, int port);
    void process_leave_room(uv_stream_t* client, const std::string& room_id, const std::string& user_id);
    void process_list_rooms(uv_stream_t* client);
    void process_heartbeat(uv_stream_t* client, const std::string& user_id);

    uv_loop_t* loop_;
    uv_tcp_t server_;
    int port_;

    UserManager user_manager_;
    RoomManager room_manager_;

    uv_timer_t heartbeat_timer_;
    uv_timer_t room_reaper_timer_;

    // user_id -> ClientContext map
    std::unordered_map<std::string, ClientContext*> user_id_to_ctx_;
    std::mutex client_map_mutex_;

    // WebRTC mixer proxy relay — single proxy registers via MIXER_REGISTER
    ClientContext* mixer_ctx_ = nullptr;
};
