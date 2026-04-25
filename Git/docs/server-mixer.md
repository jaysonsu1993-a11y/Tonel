# Tonel Server Mixing Architecture — Implementation v1.2

> 日期：2026-04-25
> 状态：已实施（P1-1: SPA1 76 字节头，5ms 帧，LEVELS 广播）

---

## 1. 背景与目标

Tonel 已完成客户端音频引擎和服务器混音架构，当前支持 3-8 人乐队实时排练。

### 延迟预算（目标 < 25ms）

| 阶段 | 耗时 |
|------|------|
| 客户端采集缓冲 | ~2.67ms（128帧 @ 48kHz）|
| 客户端发送 | ~1ms |
| 网络传输（局域网）| ~1-5ms |
| **服务器混音处理** | **< 2ms（目标）** |
| 服务器广播 | ~1ms |
| 客户端抖动缓冲 | ~5-10ms |
| 客户端播放缓冲 | ~2.67ms |
| **总计** | **< 25ms** |

---

## 2. 网络拓扑

### 星型服务器混音（当前实现）

```
  Guitar →──────────┐
                    │
  Bass   →──┐  ┌────▼──────────┐
            │  │               │
  Drums   →─┼──▼──── Server ◄──┼── Signaling (TCP 9003)
            │   Mixer          │
  Keys    →─┴────▲─────────────┘   WebSocket (9004/9005)
                  │
  Vocal   →───────┘
```

- 所有客户端发送 UDP 音频流到 Mixer Server（UDP:9003）
- Mixer Server 混音后通过 UDP 广播到每个客户端
- Mixer 控制通道（TCP:9002）处理 MIXER_JOIN/LEAVE 和 LEVELS 广播
- Signaling Server（TCP:9001）负责房间管理、WebRTC SDP 中继
- WebSocket Proxy（9004）为 Web 客户端提供信令兼容层
- WebRTC Mixer Proxy 为 Web 客户端桥接 DataChannel ↔ TCP/UDP
- 优点：客户端简单，无需混音逻辑
- 缺点：服务器上行带宽随客户端数量线性增长

**当前限制：Phase 1 最多支持 8 人**

---

## 3. 数据包格式

### 3.1 SPA1 协议（客户端 ↔ 服务器双向使用）

```cpp
// P1-1: 76 字节固定头（server/src/mixer_server.h）
#pragma pack(push, 1)
struct SPA1Packet {
    uint32_t magic;          // 0x53415031 == "SPA1" (BE)
    uint16_t sequence;       // 包序号 (BE)
    uint16_t timestamp;      // 播放时间戳 (BE)
    uint8_t  userId[64];     // "roomId:userId", null 终止
    uint8_t  codec;          // 0=PCM16, 1=Opus, 0xFF=Handshake
    uint16_t dataSize;       // payload 字节数 (BE), 上限 1356
    uint8_t  reserved;       // 保留
    uint8_t  data[];         // 音频数据
};
#pragma pack(pop)
static_assert(sizeof(SPA1Packet) == 76);
```

> 客户端和服务器使用相同的 SPA1 格式。服务器混音后回传的包也是 SPA1，userId 填写接收者的 "roomId:userId"。
>
> **电平数据**通过 TCP 控制通道 JSON `LEVELS` 消息广播（~20Hz），不在 SPA1 头中。

---

## 4. 服务器混音算法

### 4.1 核心混音

```cpp
// 输入：多个客户端的音频帧（float[], 交错 stereo）
// 输出：混音后 float[]

void mixAudio(float* out, const std::vector<ClientStream>& streams, int frames, int channels) {
    memset(out, 0, frames * channels * sizeof(float));

    for (const auto& s : streams) {
        float gain = s.gain;  // 0.0 ~ 1.0
        for (int i = 0; i < frames * channels; ++i) {
            out[i] += s.audio[i] * gain;
        }
    }

    // 防止溢出：软限幅（tanh 压缩）
    for (int i = 0; i < frames * channels; ++i) {
        out[i] = std::tanh(out[i]);  // 软限幅，避免硬削波
    }
}
```

### 4.2 为什么不归一化？

- 归一化需要额外遍历，且乐队场景通常有明确的主次角色
- 使用**软限幅**（tanh）更适合音乐信号，保持动态范围
- 客户端音量由各乐手自主控制

---

## 5. libuv 架构

### 5.1 事件循环

```
uv_loop_t
├── uv_tcp_t tcp_server_      (TCP:9002, 控制通道 — MIXER_JOIN/LEAVE/LEVELS)
├── uv_udp_t udp_server_      (UDP:9003, SPA1 音频收发)
└── uv_timer_t mix_timer_     (5ms 定时混音 + 每 50ms LEVELS 广播)
```

### 5.2 混音触发策略

**定时器驱动（5ms 周期）**
- `mix_timer_` 每 5ms 触发一次 `handle_mix_timer()`
- 仅在 `room->pending_mix = true`（有新音频到达）时执行混音
- 每 10 个 tick（50ms ≈ 20Hz）广播一次 LEVELS 消息

### 5.3 数据结构

```cpp
// 服务器运行时状态
class AudioMixer {
    uv_loop_t* loop_;

    // 客户端状态表（最多 MAX_CLIENTS = 8）
    static constexpr size_t MAX_CLIENTS = 8;
    struct ClientState {
        uint16_t id;
        bool active;                // 最近 5s 内有数据
        uint64_t last_heartbeat;    // μs
        float latest_audio[256 * 2];// 最新帧（来自 jitter buffer）
        uint32_t latest_seq;
        uint16_t latest_frames;
        uv_udp_t* send_socket;      // 向该客户端发送的 socket
        sockaddr_in addr;           // 客户端地址
    };
    ClientState clients_[MAX_CLIENTS];

    // 混音输出缓冲
    float mix_buffer_[256 * 2];     // 最大 256 帧 stereo

    // 统计
    uint64_t packets_received_;
    uint64_t packets_mixed_;
    int64_t processing_time_us_;    // 混音耗时监控
};
```

---

## 6. 信令（Signaling）

### 6.1 架构变更：UDP 扩展 → TCP JSON

**设计变更**：原始设计使用 UDP 扩展包做信令控制，实际实现改为通过 **Signaling Server（TCP 9003）** 使用 JSON 消息，并通过 WebSocket Proxy（9004/9005）向 Web 客户端暴露。

混音控制信令消息：

```json
// 客户端 → Signaling Server：请求加入混音
{
  "type": "MIXER_JOIN",
  "room_id": "room_123",
  "user_id": "user_abc",
  "ip": "192.168.1.100",
  "port": 5000
}

// Signaling Server → Mixer Server：内部转发
{
  "type": "MIXER_JOIN",
  "client_id": 1,
  "ip": "192.168.1.100",
  "port": 5000
}

// 客户端离开
{
  "type": "MIXER_LEAVE",
  "room_id": "room_123",
  "user_id": "user_abc"
}
```

### 6.2 连接流程

```
Client                          Signaling Server              Mixer Server
  │                                │                              │
  │───── CREATE_ROOM ─────────────▶│                              │
  │◀──── ack (room_id) ────────────│                              │
  │                                │                              │
  │───── MIXER_JOIN ──────────────▶│───── TCP JSON ─────────────▶│  注册客户端
  │                                │                              │  分配 client_id
  │                                │                              │
  │═════ Audio Stream (UDP 9001) ════════════════════════════════▶│
  │                                │                              │
  │◀════ Mixed Audio (UDP) ══════════════════════════════════════│
  │                                │                              │
  │───── MIXER_LEAVE ─────────────▶│───── TCP JSON ─────────────▶│  注销客户端
```

### 6.3 NAT 穿透

Phase 1：同局域网直连（当前实现）
Phase 2：引入 STUN/TURN（中继服务器）— 规划中

---

## 7. 性能估算

### 7.1 带宽计算（4 人乐队）

| 方向 | 速率 |
|------|------|
| 每个客户端上行 | 128帧 × 2ch × 4B × 46.9fps ≈ **48 KB/s ≈ 384 Kbps** |
| 服务器下行（3 人混音）| 48 KB/s × 3 ≈ **144 KB/s ≈ 1.15 Mbps** |

这个带宽完全可接受。

### 7.2 混音延迟分解

```
客户端采集 (128帧)     : 2.67ms
客户端发送             : 0ms (UDP fire-and-forget)
网络传输 (局域网)       : 0.5-2ms
服务器混音             : < 0.5ms (纯内存加法)
服务器广播             : 0ms (UDP)
网络传输 (下行)         : 0.5-2ms
客户端抖动缓冲          : 5ms (自适应)
客户端播放 (128帧)      : 2.67ms
──────────────────────────────
总计                   : ~13-17ms ✅
```

---

## 8. 实现状态

### ✅ Phase 1: 核心服务器（已完成）
- [x] `AudioMixer` 类（C++ + libuv）
- [x] 客户端连接状态管理
- [x] 混音算法实现（含软限幅）
- [x] UDP 广播发送
- [x] 简单压测（单台服务器 4 人）

### ✅ Phase 2: 信令系统（已完成）
- [x] TCP JSON 信令（取代 UDP 扩展）
- [x] MIXER_JOIN / MIXER_LEAVE 控制
- [x] WebSocket Proxy 兼容层

### ⏳ Phase 3: 丢包与抖动（进行中）
- [x] 客户端 jitter buffer（参考 Tonel-Mini）
- [ ] 服务器端 PLC（混音时的丢包补偿）

### ⏳ Phase 4: 调优
- [ ] 帧率 vs 延迟权衡（64/128/256 帧）
- [ ] 混音批量处理（合并多个小包）
- [ ] QoS 标记（DSCP）

---

## 9. 文件结构

```
server/
├── CMakeLists.txt
├── src/
│   ├── main.cpp                # Signaling Server 入口
│   ├── signaling_server.cpp    # TCP JSON 信令处理
│   ├── signaling_server.h
│   ├── room.cpp / room.h       # 房间管理（含 PBKDF2 密码哈希）
│   ├── user.cpp / user.h       # 用户管理
│   ├── password_hasher.cpp     # OpenSSL PBKDF2-HMAC-SHA256
│   ├── password_hasher.h
│   ├── audio_mixer.cpp         # 混音器核心
│   ├── mixer_server.cpp        # Mixer Server UDP 入口
│   ├── mixer_server_test.cpp   # 混音器测试
│   └── AudioRecorder.cpp       # 音频录制工具
└── tests/
    └── (集成测试中)
```

---

## 10. 协议版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-04-10 | 初始设计文档（UDP 扩展信令，magic=0x53410001）|
| v1.1 | 2026-04-22 | TCP JSON 信令，SPA1 magic=0x53415031 |
| v1.2 | 2026-04-25 | P1-1: SPA1 头扩至 76 字节（userId 64B），5ms 帧，LEVELS 广播，dataSize 上限，TCP UAF 修复 |

---

*文档版本：v1.2 | 作者：Niko | 2026-04-25*
