#include "mixer_server.h"

#include <iostream>
#include <sstream>
#include <regex>
#include <cstdlib>
#include <cstring>
#include <arpa/inet.h>
#include <opus.h>

// ============================================================
// Forward-declare this before MixerServer member functions that use it
// ============================================================
static void send_tcp_response(uv_stream_t* client, const std::string& msg);

// ============================================================
// SimpleJson
// ============================================================

// P0-3: dataSize upper bound, prevents large allocations
constexpr size_t MAX_PAYLOAD_SIZE = 1356;

MixerServer::SimpleJson MixerServer::SimpleJson::parse(const std::string& str) {
    SimpleJson j;
    std::smatch m;

    std::regex type_re("\"type\"\\s*:\\s*\"([^\"]*)\"");
    if (std::regex_search(str, m, type_re)) j.type = m[1].str();

    std::regex room_re("\"room_id\"\\s*:\\s*\"([^\"]*)\"");
    if (std::regex_search(str, m, room_re)) j.room_id = m[1].str();

    std::regex user_re("\"user_id\"\\s*:\\s*\"([^\"]*)\"");
    if (std::regex_search(str, m, user_re)) j.user_id = m[1].str();

    std::regex data_re("\"data\"\\s*:\\s*\"([^\"]*)\"");
    if (std::regex_search(str, m, data_re)) j.data = m[1].str();

    return j;
}

static std::string base64_encode(const uint8_t* data, size_t len) {
    static const char tbl[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((len + 2) / 3 * 4);
    for (size_t i = 0; i < len; i += 3) {
        int v = (data[i] << 16);
        if (i + 1 < len) v |= (data[i + 1] << 8);
        if (i + 2 < len) v |= data[i + 2];
        out.push_back(tbl[(v >> 18) & 0x3F]);
        out.push_back(tbl[(v >> 12) & 0x3F]);
        out.push_back(i + 1 < len ? tbl[(v >> 6) & 0x3F] : '=');
        out.push_back(i + 2 < len ? tbl[v & 0x3F] : '=');
    }
    // Strip trailing "==" or "="
    while (!out.empty() && out.back() == '=') out.pop_back();
    return out;
}

std::string MixerServer::SimpleJson::make_mixed_audio(
        const std::string& user_id, const void* audio, size_t bytes) {
    const uint8_t* d = reinterpret_cast<const uint8_t*>(audio);
    std::string b64 = base64_encode(d, bytes);
    return std::string("{\"type\":\"MIXED_AUDIO\",\"from_user\":\"") + user_id
         + "\",\"data\":\"" + b64 + "\"}";
}

std::string MixerServer::SimpleJson::make_error(const std::string& msg) {
    return std::string("{\"type\":\"ERROR\",\"message\":\"") + msg + "\"}";
}

std::string MixerServer::SimpleJson::make_ack(const std::string& type) {
    return std::string("{\"type\":\"") + type + "_ACK\"}";
}

std::string MixerServer::SimpleJson::make_mixer_join_ack(int udp_port) {
    return std::string("{\"type\":\"MIXER_JOIN_ACK\",\"udp_port\":") + std::to_string(udp_port) + "}";
}

// ============================================================
// PCM16 helpers
// ============================================================

void MixerServer::pcm16_to_float(const int16_t* src, float* dst, int count) {
    for (int i = 0; i < count; ++i) {
        dst[i] = src[i] / 32768.0f;
    }
}

void MixerServer::float_to_pcm16(const float* src, int16_t* dst, int count) {
    for (int i = 0; i < count; ++i) {
        float v = std::max(-1.0f, std::min(1.0f, src[i]));
        dst[i] = static_cast<int16_t>(v * 32767.0f);
    }
}

// ============================================================
// Opus helpers
// ============================================================

void MixerServer::opus_state_init(OpusCodecState* s, int sample_rate,
                                   int channels, int frame_size) {
    if (!s) return;
    int enc_err, dec_err;
    s->enc = ::opus_encoder_create(sample_rate, channels,
                                   OPUS_APPLICATION_RESTRICTED_LOWDELAY, &enc_err);
    s->dec = ::opus_decoder_create(sample_rate, channels, &dec_err);
    s->valid = (enc_err == OPUS_OK && dec_err == OPUS_OK);
    if (s->enc) {
        ::opus_encoder_ctl(reinterpret_cast<OpusEncoder*>(s->enc), OPUS_SET_BITRATE(96000));
        ::opus_encoder_ctl(reinterpret_cast<OpusEncoder*>(s->enc), OPUS_SET_VBR(1));
        ::opus_encoder_ctl(reinterpret_cast<OpusEncoder*>(s->enc), OPUS_SET_COMPLEXITY(3));  // 8→3: lower latency
    }
    s->frame_size = frame_size;
    s->pcm_decode_buf.resize(frame_size * channels);
}

void MixerServer::opus_state_free(OpusCodecState* s) {
    if (!s) return;
    if (s->enc) { ::opus_encoder_destroy(reinterpret_cast<OpusEncoder*>(s->enc)); s->enc = nullptr; }
    if (s->dec) { ::opus_decoder_destroy(reinterpret_cast<OpusDecoder*>(s->dec)); s->dec = nullptr; }
    s->valid = false;
    s->pcm_decode_buf.clear();
    s->frame_size = 0;
}

int MixerServer::opus_decode_packet(UserEndpoint* ue, const uint8_t* pkt, int len,
                                            float* out) {
    if (!ue || !ue->opus.dec || !ue->opus.valid) return -1;
    if (!pkt || len <= 0 || !out) return -1;
    if (ue->opus.pcm_decode_buf.empty()) return -1;

    int frames = ::opus_decode(reinterpret_cast<OpusDecoder*>(ue->opus.dec),
                                reinterpret_cast<const unsigned char*>(pkt), len,
                                ue->opus.pcm_decode_buf.data(), ue->opus.frame_size, 0);
    if (frames < 0) return frames;
    int channels = 2;
    for (int i = 0; i < frames * channels; ++i) {
        out[i] = ue->opus.pcm_decode_buf[i] / 32768.0f;
    }
    return frames;
}

int MixerServer::opus_encode_packet(const float* pcm, int frame_count,
                                   int channels, uint8_t* out,
                                   int max_out, int bitrate_bps) {
    if (!pcm || !out) return -1;
    static thread_local OpusEncoder* s_enc = nullptr;
    static thread_local int s_channels = 0;
    if (!s_enc || s_channels != channels) {
        if (s_enc) { ::opus_encoder_destroy(s_enc); s_enc = nullptr; }
        int err;
        s_enc = ::opus_encoder_create(48000, channels,
                                      OPUS_APPLICATION_RESTRICTED_LOWDELAY, &err);
        s_channels = channels;
        if (s_enc) {
            ::opus_encoder_ctl(s_enc, OPUS_SET_BITRATE(bitrate_bps));
            ::opus_encoder_ctl(s_enc, OPUS_SET_VBR(1));
            ::opus_encoder_ctl(s_enc, OPUS_SET_COMPLEXITY(3));  // 8→3: lower latency
        }
        (void)err;
    }
    if (!s_enc) return -1;

    std::vector<int16_t> pcm_buf(frame_count * channels);
    for (int i = 0; i < frame_count * channels; ++i) {
        float clamped = std::max(-1.0f, std::min(1.0f, pcm[i]));
        pcm_buf[i] = static_cast<int16_t>(clamped * 32767.0f);
    }
    return ::opus_encode(s_enc, pcm_buf.data(), frame_count,
                         reinterpret_cast<unsigned char*>(out), max_out);
}

// ============================================================
// TCP response helper
// ============================================================

static void send_tcp_response(uv_stream_t* client, const std::string& msg) {
    if (!client) return;
    std::string* heap = new std::string(msg + "\n");
    uv_buf_t buf = uv_buf_init(const_cast<char*>(heap->c_str()), heap->size());
    uv_write_t* req = new uv_write_t;
    req->data = heap;
    int r = uv_write(req, client, &buf, 1, [](uv_write_t* req, int) {
        delete static_cast<std::string*>(req->data);
        delete req;
    });
    if (r < 0) {
        delete heap;
        delete req;
    }
}

// ============================================================
// MixerServer
// ============================================================

MixerServer::MixerServer(uv_loop_t* loop, int tcp_port, int udp_port, int audio_frames)
    : loop_(loop)
    , tcp_port_(tcp_port)
    , udp_port_(udp_port)
    , audio_frames_(audio_frames)
    , recording_manager_()
{
    // Set recording output directory (uses default ./recordings/ if unset)
    recording_manager_.setRecordingDir("./recordings/");

    uv_tcp_init(loop, &tcp_server_);
    uv_udp_init(loop, &udp_server_);
    uv_timer_init(loop, &mix_timer_);
    tcp_server_.data = this;
    udp_server_.data = this;
    mix_timer_.data = this;
}

MixerServer::~MixerServer() = default;

void MixerServer::start() {
    // ── TCP: control channel ─────────────────────────────
    struct sockaddr_in tcp_addr;
    uv_ip4_addr("0.0.0.0", tcp_port_, &tcp_addr);
    uv_tcp_bind(&tcp_server_, (const struct sockaddr*)&tcp_addr, 0);
    int r = uv_listen((uv_stream_t*)&tcp_server_, 64,
                       &MixerServer::on_tcp_new_connection);
    if (r < 0) {
        std::cerr << "[MixerServer] TCP listen error: " << uv_strerror(r) << std::endl;
    } else {
        std::cout << "[MixerServer] TCP control channel listening on port "
                  << tcp_port_ << std::endl;
    }

    // ── UDP: audio channel ─────────────────────────────
    struct sockaddr_in udp_addr;
    uv_ip4_addr("0.0.0.0", udp_port_, &udp_addr);
    uv_udp_bind(&udp_server_, (const struct sockaddr*)&udp_addr, UV_UDP_REUSEADDR);
    r = uv_udp_recv_start(&udp_server_,
                          &MixerServer::on_tcp_alloc,   // re-use alloc callback
                          &MixerServer::on_udp_recv);
    if (r < 0) {
        std::cerr << "[MixerServer] UDP recv start error: " << uv_strerror(r) << std::endl;
    } else {
        std::cout << "[MixerServer] UDP audio channel listening on port "
                  << udp_port_ << std::endl;
    }

    // ── Timer: 5ms periodic mixing ─────────────────────────────────
    uv_timer_start(&mix_timer_, &MixerServer::on_mix_timer, 5, 5);
    std::cout << "[MixerServer] Timed mixing enabled (5ms interval, "
              << audio_frames_ << " frames/packet)" << std::endl;
}

// ============================================================
// Room management
// ============================================================

MixerServer::Room* MixerServer::getOrCreateRoom(const std::string& room_id) {
    std::lock_guard<std::mutex> lock(rooms_mutex_);
    auto& ptr = rooms_[room_id];
    if (!ptr) {
        ptr = std::make_unique<Room>();
        ptr->id = room_id;
    }
    return ptr.get();
}

MixerServer::Room* MixerServer::getRoom(const std::string& room_id) {
    std::lock_guard<std::mutex> lock(rooms_mutex_);
    auto it = rooms_.find(room_id);
    return (it != rooms_.end()) ? it->second.get() : nullptr;
}

void MixerServer::removeRoom(const std::string& room_id) {
    std::lock_guard<std::mutex> lock(rooms_mutex_);
    rooms_.erase(room_id);
    std::cout << "[MixerServer] Room removed: " << room_id << std::endl;
}

// ============================================================
// TCP callbacks
// ============================================================

void MixerServer::on_tcp_new_connection(uv_stream_t* server, int status) {
    auto* self = static_cast<MixerServer*>(server->data);
    if (status < 0) {
        std::cerr << "[MixerServer] TCP connection error: " << uv_strerror(status) << std::endl;
        return;
    }
    auto* client = new uv_tcp_t;
    uv_tcp_init(self->loop_, client);
    client->data = self;
    if (uv_accept(server, (uv_stream_t*)client) == 0) {
        uv_read_start((uv_stream_t*)client,
                      &MixerServer::on_tcp_alloc,
                      &MixerServer::on_tcp_read);
    } else {
        uv_close((uv_handle_t*)client, [](uv_handle_t* h) {
            delete reinterpret_cast<uv_tcp_t*>(h);
        });
    }
}

void MixerServer::on_tcp_alloc(uv_handle_t*, size_t, uv_buf_t* buf) {
    static thread_local char slab[4096];
    buf->base = slab;
    buf->len = static_cast<unsigned int>(sizeof(slab));
}

void MixerServer::on_tcp_read(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {
    auto* self = static_cast<MixerServer*>(stream->data);
    if (nread < 0) {
        uv_close((uv_handle_t*)stream, nullptr);
        return;
    }
    if (nread == 0) return;
    self->handle_tcp_read(stream, nread, buf);
}

void MixerServer::on_tcp_close(uv_handle_t*) {
    // Nothing persistent to clean up
}

// ============================================================
// TCP message handling
// ============================================================

void MixerServer::handle_tcp_read(uv_stream_t* client, ssize_t nread,
                                   const uv_buf_t* buf) {
    if (nread <= 0) return;
    std::string data(buf->base, static_cast<size_t>(nread));

    size_t start = 0;
    while (start < data.size()) {
        size_t pos = data.find('\n', start);
        if (pos == std::string::npos) break;
        std::string msg = data.substr(start, pos - start);
        if (!msg.empty() && msg.back() == '\r') msg.pop_back();
        start = pos + 1;
        if (!msg.empty()) handle_control_message(client, msg);
    }
}

void MixerServer::handle_control_message(uv_stream_t* client,
                                          const std::string& msg) {
    auto j = SimpleJson::parse(msg);

    if (j.type == "MIXER_JOIN") {
        if (j.room_id.empty() || j.user_id.empty()) {
            send_tcp_response(client, SimpleJson::make_error("room_id and user_id required"));
            return;
        }
        Room* room = getOrCreateRoom(j.room_id);
        {
            std::lock_guard<std::mutex> lock(rooms_mutex_);
            UserEndpoint ue;
            ue.user_id = j.user_id;
            ue.addr_valid = false;
            ue.preferred_codec = SPA1_CODEC_PCM16;
            ue.tcp_client = client;
            opus_state_init(&ue.opus, 48000, 2, audio_frames_);
            room->users[j.user_id] = ue;
            user_room_index_[j.user_id] = j.room_id;

            // Start recording when first user joins the room
            if (!room->recording) {
                std::string path = recording_manager_.startRecording(j.room_id);
                if (!path.empty()) {
                    room->recording = true;
                    std::cout << "[MixerServer] Recording started: " << path << std::endl;
                }
            }
        }
        // Issue #4 fix: tell client our UDP port so it can send a handshake.
        send_tcp_response(client, SimpleJson::make_mixer_join_ack(udp_port_));
        std::cout << "[MixerServer] " << j.user_id << " joined room " << j.room_id
                  << " (tracks: " << room->mixer.trackCount() << ")" << std::endl;

    } else if (j.type == "MIXER_LEAVE") {
        if (j.room_id.empty() || j.user_id.empty()) {
            send_tcp_response(client, SimpleJson::make_error("room_id and user_id required"));
            return;
        }
        Room* room = getRoom(j.room_id);
        bool roomWasEmpty = false;
        if (room) {
            room->mixer.removeTrack(j.user_id);
            {
                std::lock_guard<std::mutex> lock(rooms_mutex_);
                auto uit = room->users.find(j.user_id);
                if (uit != room->users.end()) {
                    opus_state_free(&uit->second.opus);
                }
                room->users.erase(j.user_id);
                user_room_index_.erase(j.user_id);
                roomWasEmpty = room->users.empty();
                // Stop recording when last user leaves
                if (roomWasEmpty && room->recording) {
                    recording_manager_.stopRecording(j.room_id);
                    room->recording = false;
                    std::cout << "[MixerServer] Recording saved for room " << j.room_id << std::endl;
                }
            }
            if (roomWasEmpty) {
                removeRoom(j.room_id);
            }
        }
        send_tcp_response(client, SimpleJson::make_ack("MIXER_LEAVE"));
        std::cout << "[MixerServer] " << j.user_id << " left room " << j.room_id << std::endl;

    } else {
        send_tcp_response(client, SimpleJson::make_error("Unknown type: " + j.type));
    }
}

// ============================================================
// UDP audio handling
// ============================================================

void MixerServer::on_udp_recv(uv_udp_t* handle, ssize_t nread,
                              const uv_buf_t* buf,
                              const struct sockaddr* addr, unsigned) {
    auto* self = static_cast<MixerServer*>(handle->data);
    if (nread < 0 || addr == nullptr) {
        // libuv auto-recycles the thread_local static slab — do NOT free() it
        return;
    }
    const struct sockaddr_in* addr_in = reinterpret_cast<const struct sockaddr_in*>(addr);
    self->handle_udp_audio(reinterpret_cast<const uint8_t*>(buf->base),
                           static_cast<size_t>(nread), *addr_in);
    // libuv auto-recycles the thread_local static slab — do NOT free() it
}

void MixerServer::handle_udp_audio(const uint8_t* data, size_t len,
                                    const struct sockaddr_in& client_addr) {
    (void)client_addr;

    if (len < sizeof(SPA1Packet)) return;

    const SPA1Packet* pkt = reinterpret_cast<const SPA1Packet*>(data);

    uint32_t magic    = ntohl(pkt->magic);
    uint16_t sequence = ntohs(pkt->sequence);
    uint16_t timestamp = ntohs(pkt->timestamp);
    (void)sequence;    // now unused: server generates its own sequence in timed mixer
    (void)timestamp;   // now unused: server generates its own timestamp in timed mixer
    uint16_t dataSize = ntohs(pkt->dataSize);

    if (magic != SPA1_MAGIC) return;

    // P0-5: validate dataSize before use
    if (dataSize > MAX_PAYLOAD_SIZE) return;

    // Extract null-terminated userId from fixed 32-byte field
    char uid_buf[33] = {0};
    std::memcpy(uid_buf, pkt->userId, 32);
    std::string user_id(uid_buf);
    if (user_id.empty()) return;

    if (len < sizeof(SPA1Packet) + dataSize) return;

    uint8_t codec = pkt->codec;

    // Issue #4 fix: SPA1_TYPE_HANDSHAKE (codec=0xFF) — "room_id:user_id" in userId field.
    // Register the client's UDP address so they receive mixed audio from frame 1.
    if (codec == 0xFF) {
        // userId format: "room_id:user_id" (split on first ':')
        std::string uid_str(uid_buf);
        size_t sep = uid_str.find(':');
        if (sep != std::string::npos) {
            std::string r_id = uid_str.substr(0, sep);
            std::string u_id = uid_str.substr(sep + 1);
            std::lock_guard<std::mutex> lock(rooms_mutex_);
            auto it = rooms_.find(r_id);
            if (it != rooms_.end()) {
                auto uit = it->second->users.find(u_id);
                if (uit != it->second->users.end()) {
                    uit->second.addr = client_addr;
                    uit->second.addr_valid = true;
                    std::cout << "[MixerServer] Handshake registered " << u_id
                              << " @ " << inet_ntoa(client_addr.sin_addr)
                              << ":" << ntohs(client_addr.sin_port) << std::endl;
                }
            }
        }
        return;
    }

    const int frame_count = audio_frames_;
    std::vector<float> float_buf(frame_count);

    if (codec == SPA1_CODEC_OPUS) {
        // Find user endpoint via O(1) index and decode Opus -> float
        UserEndpoint* ue_ptr = nullptr;
        {
            std::lock_guard<std::mutex> lock(rooms_mutex_);
            auto idx_it = user_room_index_.find(user_id);
            if (idx_it != user_room_index_.end()) {
                auto room_it = rooms_.find(idx_it->second);
                if (room_it != rooms_.end()) {
                    auto uit = room_it->second->users.find(user_id);
                    if (uit != room_it->second->users.end()) {
                        ue_ptr = &uit->second;
                    }
                }
            }
        }
        if (!ue_ptr) return;
        int decoded = opus_decode_packet(ue_ptr, pkt->data, dataSize,
                                         float_buf.data());
        if (decoded < 0) {
            std::cerr << "[MixerServer] Opus decode error for " << user_id << std::endl;
            return;
        }
    } else if (codec == SPA1_CODEC_PCM16) {
        // Decode PCM16 -> float
        const int16_t* pcm = reinterpret_cast<const int16_t*>(pkt->data);
        pcm16_to_float(pcm, float_buf.data(), frame_count);
    } else {
        std::cerr << "[MixerServer] Unknown codec " << (int)codec << " from " << user_id << std::endl;
        return;
    }

    // Find the user's room via O(1) index and update state — keep lock held for
    // all Room operations to prevent UAF during iteration.
    {
        std::lock_guard<std::mutex> lock(rooms_mutex_);
        auto idx_it = user_room_index_.find(user_id);
        if (idx_it == user_room_index_.end()) return;

        auto room_it = rooms_.find(idx_it->second);
        if (room_it == rooms_.end()) return;
        Room* target_room = room_it->second.get();

        // Update mixer track and UDP endpoint while still holding the lock.
        target_room->mixer.addTrack(user_id, float_buf.data(), frame_count);
        target_room->pending_mix = true;
        auto it = target_room->users.find(user_id);
        if (it != target_room->users.end()) {
            it->second.addr = client_addr;
            it->second.addr_valid = true;

            // Update codec preference and init Opus encoder if needed
            if (codec == SPA1_CODEC_OPUS && it->second.preferred_codec != SPA1_CODEC_OPUS) {
                it->second.preferred_codec = SPA1_CODEC_OPUS;
                opus_state_free(&it->second.opus);
                opus_state_init(&it->second.opus, 48000, 2, audio_frames_);
                std::cout << "[MixerServer] User " << user_id
                          << " switched to Opus (opus valid=" << it->second.opus.valid << ")\n";
            }
        }
        // broadcast_mixed_audio is now called by the 5ms timer (handle_mix_timer)
    }
}

// ============================================================
// Mixed audio broadcast
// ============================================================

void MixerServer::broadcast_mixed_audio(Room* room,
                                         uint16_t sequence,
                                         uint16_t timestamp) {
    const int frame_count = audio_frames_;

    std::vector<float> mixed(frame_count);
    room->mixer.mix(mixed.data(), frame_count);

    // Record the mixed audio if this room is being recorded
    if (room->recording) {
        recording_manager_.writeFrames(room->id, mixed.data(), frame_count);
    }

    // Pre-encode once for all recipients (mixed audio is identical for everyone)
    // Opus encoding
    std::vector<uint8_t> opus_encoded;
    bool has_opus = false;
    {
        opus_encoded.resize(4000);
        int encoded = opus_encode_packet(mixed.data(), frame_count, 2,
                                         opus_encoded.data(), (int)opus_encoded.size(),
                                         96000);
        if (encoded > 0) {
            opus_encoded.resize(encoded);
            has_opus = true;
        }
    }

    // PCM16 encoding
    std::vector<uint8_t> pcm_encoded(frame_count * sizeof(int16_t));
    float_to_pcm16(mixed.data(),
                   reinterpret_cast<int16_t*>(pcm_encoded.data()),
                   frame_count);

    // Send to each recipient via UDP — caller must hold rooms_mutex_
    for (const auto& kv : room->users) {
        if (!kv.second.addr_valid) continue;
        const UserEndpoint& ue = kv.second;
        const struct sockaddr_in& addr = ue.addr;

        uint8_t codec = ue.preferred_codec;
        const uint8_t* audio_data;
        size_t audio_bytes;

        if (codec == SPA1_CODEC_OPUS && ue.opus.valid && has_opus) {
            audio_data = opus_encoded.data();
            audio_bytes = opus_encoded.size();
        } else {
            codec = SPA1_CODEC_PCM16;
            audio_data = pcm_encoded.data();
            audio_bytes = pcm_encoded.size();
        }

        // Build SPA1 packet
        std::vector<uint8_t> pkt_buf(sizeof(SPA1Packet) + audio_bytes);
        SPA1Packet* out_pkt = reinterpret_cast<SPA1Packet*>(pkt_buf.data());
        out_pkt->magic      = htonl(SPA1_MAGIC);
        out_pkt->sequence   = htons(sequence);
        out_pkt->timestamp  = htons(timestamp);
        // Write recipient's "roomId:userId" so the web proxy can route by userId.
        const std::string uid_key = room->id + ":" + kv.first;
        std::memset(out_pkt->userId, 0, 32);
        std::strncpy(reinterpret_cast<char*>(out_pkt->userId), uid_key.c_str(), 31);
        out_pkt->codec      = codec;
        out_pkt->dataSize   = htons(static_cast<uint16_t>(audio_bytes));
        memcpy(out_pkt->data, audio_data, audio_bytes);

        const size_t pkt_len = sizeof(SPA1Packet) + audio_bytes;
        uv_udp_send_t* req = new uv_udp_send_t;
        std::vector<uint8_t>* heap_buf = new std::vector<uint8_t>(std::move(pkt_buf));
        uv_buf_t uvbuf = uv_buf_init(
            reinterpret_cast<char*>(heap_buf->data()),
            pkt_len);
        req->data = heap_buf;
        int sr = uv_udp_send(req, &udp_server_, &uvbuf, 1,
                    reinterpret_cast<const struct sockaddr*>(&addr),
                    [](uv_udp_send_t* req, int) {
                        delete static_cast<std::vector<uint8_t>*>(req->data);
                        delete req;
                    });
        if (sr < 0) {
            delete heap_buf;
            delete req;
        }
    }
}

// ============================================================
// Per-user level broadcast (via TCP control channel)
// ============================================================

void MixerServer::broadcast_levels(Room* room) {
    // Build JSON: {"type":"LEVELS","levels":{"user1":0.42,"user2":0.15,...}}
    std::string json = "{\"type\":\"LEVELS\",\"levels\":{";
    bool first = true;
    for (const auto& kv : room->users) {
        // mixer tracks are keyed by "roomId:userId", room->users by "userId"
        std::string track_key = room->id + ":" + kv.first;
        float rms = room->mixer.getTrackLevel(track_key);
        // Scale for visual sensitivity and clamp to 0-1
        float level = std::min(1.0f, rms * 2.5f);
        if (!first) json += ",";
        json += "\"" + kv.first + "\":" + std::to_string(level);
        first = false;
    }
    json += "}}";

    // Send to all users in the room who have a TCP connection
    for (const auto& kv : room->users) {
        if (kv.second.tcp_client) {
            send_tcp_response(kv.second.tcp_client, json);
        }
    }
}

// ============================================================
// Timed mixing — 5ms periodic mixer to unify frame boundaries
// ============================================================

void MixerServer::on_mix_timer(uv_timer_t* handle) {
    auto* self = static_cast<MixerServer*>(handle->data);
    self->handle_mix_timer();
}

void MixerServer::handle_mix_timer() {
    std::lock_guard<std::mutex> lock(rooms_mutex_);

    bool send_levels = false;
    level_tick_counter_++;
    if (level_tick_counter_ >= 10) {  // every 10 ticks (50ms) ≈ 20Hz
        level_tick_counter_ = 0;
        send_levels = true;
    }

    for (auto& kv : rooms_) {
        Room* room = kv.second.get();
        if (!room || !room->pending_mix) continue;

        room->pending_mix = false;
        mix_sequence_++;
        broadcast_mixed_audio(room, mix_sequence_, 0);

        if (send_levels) {
            broadcast_levels(room);
        }
    }
}
