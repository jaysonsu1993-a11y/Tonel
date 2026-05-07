#pragma once

#include <uv.h>
#include <string>
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
    // True when a newer session for the same user_id has taken over.
    // Set by process_join_room when it kicks an existing ctx; on_close
    // honors it by skipping the leave_room/user_id_to_ctx_/user_manager_
    // cascade — that state already belongs to the new ctx and would
    // otherwise erase a live session.
    bool displaced = false;
    // v6.5.0 P2P transport: client's audio UDP endpoint, registered via
    // REGISTER_AUDIO_ADDR after the client has done UDP NAT discovery.
    // Empty `audio_public_ip` means "not registered yet" — peers will
    // not be told about this client until they are. The local_* pair
    // is the LAN address the client claims to bind on; some networks
    // can use it to bypass hole-punching when both peers are on the
    // same subnet.
    std::string audio_public_ip;
    uint16_t    audio_public_port = 0;
    std::string audio_local_ip;
    uint16_t    audio_local_port  = 0;
    std::string audio_room_id;          // room this addr is registered in
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
                              const std::string& user_id, const std::string& password);
    void process_leave_room(uv_stream_t* client, const std::string& room_id, const std::string& user_id);
    void process_list_rooms(uv_stream_t* client);
    void process_heartbeat(uv_stream_t* client, const std::string& user_id);
    // v6.5.0 P2P transport: client tells the server its audio UDP
    // endpoint after running NAT discovery. Server stores the (public,
    // local) pair on the ClientContext, then broadcasts PEER_ADDR to
    // the rest of the room and replies to this caller with PEER_ADDR
    // for every already-registered peer. The pair (`public_ip`,
    // `public_port`) and (`local_ip`, `local_port`) are taken from
    // the JSON; we don't trust the TCP source IP because Tonel-MacOS
    // signals through Cloudflare Tunnel (api.tonel.io) and the CF
    // edge would otherwise be reported as the client's "public" IP.
    void process_register_audio_addr(uv_stream_t* client,
                                     const std::string& room_id,
                                     const std::string& user_id,
                                     const std::string& public_ip,
                                     uint16_t           public_port,
                                     const std::string& local_ip,
                                     uint16_t           local_port);

    // ── UDP discovery (v6.5.0 P2P) ──────────────────────────────
    // libuv UDP listener bound to the same port as the TCP signaling
    // socket. Receives `{"type":"DISCOVER","user_id":"..."}` packets
    // and replies with `{"type":"DISCOVER_REPLY","public_ip":...,
    // "public_port":...}` so the client learns its NAT-mapped UDP
    // address — the public_ip slot it needs for REGISTER_AUDIO_ADDR.
    static void on_udp_alloc(uv_handle_t*, size_t, uv_buf_t*);
    static void on_udp_recv(uv_udp_t* handle, ssize_t nread,
                            const uv_buf_t* buf,
                            const struct sockaddr* addr, unsigned flags);
    void handle_udp_discover(const std::string& payload,
                             const struct sockaddr_in& src);

    uv_loop_t* loop_;
    uv_tcp_t server_;
    uv_udp_t udp_server_;   // P2P discovery
    int port_;

    UserManager user_manager_;
    RoomManager room_manager_;

    uv_timer_t heartbeat_timer_;
    uv_timer_t room_reaper_timer_;

    // user_id -> ClientContext map
    std::unordered_map<std::string, ClientContext*> user_id_to_ctx_;
    std::mutex client_map_mutex_;
};
