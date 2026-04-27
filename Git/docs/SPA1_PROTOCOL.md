# SPA1 — Simple Protocol for Audio v1

> 对应实现：`server/src/mixer_server.h`（C++ 结构体）、`web/src/services/audioService.ts`（JS 编解码）

## 概述

SPA1 是一个为实时排练场景设计的轻量级二进制音频协议。采用 UDP 传输（音频流）和 TCP 传输（信令消息）。所有多字节字段均采用网络字节序（大端序）。

---

## 包格式（76 字节固定头 + payload）

> P1-1 变更（2026-04-25）：userId 从 32 扩展至 64 字节，总头长从 44 增至 76 字节。
> 同时移除了旧版的 `type` 和 `level` 字段，简化头结构。

```
偏移  大小  类型       字段         说明
──────────────────────────────────────────────────────────────
0     4     u32 BE    magic       0x53415031 ('SPA1')
4     2     u16 BE    sequence    包序号（递增）
6     2     u16 BE    timestamp   发送端本地毫秒低16位，服务器透传用于RTT测量
8     64    char[64]  userId      用户标识符，null 终止（P1-1: 64 字节）
72    1     u8        codec       0=PCM16, 1=Opus, 0xFF=Handshake
73    2     u16 BE    dataSize    payload 字节数（上限 1356）
75    1     u8        reserved    保留 / 未来扩展标志位
──────────────────────────────────────────────────────────────
76+   N     uint8[]   data        音频数据
──────────────────────────────────────────────────────────────
      ── 总头长：76 字节 ──
```

### 各字段详解

| 字段 | 类型 | 偏移 | 说明 |
|------|------|------|------|
| `magic` | u32 BE | 0 | 固定值 `0x53415031`，用于协议识别与校验 |
| `sequence` | u16 BE | 4 | 包序号，每包递增，接收端用于检测丢包和排序 |
| `timestamp` | u16 BE | 6 | 客户端发送时写入本地毫秒低 16 位，服务器透传回客户端用于计算音频 RTT |
| `userId` | char[64] | 8 | 格式 `"roomId:userId"`，null 终止。P1-1 扩展至 64 字节 |
| `codec` | u8 | 72 | 音频编码器：`0=PCM16`，`1=Opus`，`0xFF=Handshake` |
| `dataSize` | u16 BE | 73 | `data` payload 的实际字节数，上限 1356 字节 |
| `reserved` | u8 | 75 | 保留字段，置 0 |

### 电平传输

> 旧版 SPA1 在包头内嵌入了 `level` 字段。P1-1 移除了该字段。
> 电平数据现在通过 TCP 控制通道以 JSON `LEVELS` 消息广播（~20Hz），
> 格式：`{"type":"LEVELS","levels":{"userId1":0.42,"userId2":0.15,...}}`。
> 值域 0.0-1.0，由服务器从 AudioMixer track RMS 计算。

---

## 支持的 Codec

| 值 | 名称 | 格式 | 说明 |
|----|------|------|------|
| `0x00` | PCM16 | 48kHz / 16bit / mono / 无压缩 | 适合低延迟本地网络 |
| `0x01` | Opus | 有损压缩（可变码率） | 适合互联网传输，降低带宽 |
| `0xFF` | Handshake | — | 用于 UDP 打洞地址注册（见下方） |

### PCM16 帧结构

- 帧长：**5 ms** = 240 samples @ 48kHz（默认配置，追求最低延迟）
- 每帧字节数：240 × 2 = **480 bytes**
- 服务器 `audio_frames_` 参数可调（如 480=10ms、960=20ms）

### Opus 帧结构

- 帧长：同 PCM16 配置（5ms/10ms/20ms）
- 每帧字节数：可变，典型约 **20-60 bytes**（5ms），**80-120 bytes**（20ms）
- 相比 PCM16 可节省 >90% 带宽

---

## Handshake 包（UDP 打洞）

`type = HANDSHAKE` 的包用于在 P2P 连接建立前，在信令服务器的协调下完成 UDP 打洞（STUN）。

```
SPA1Packet {
    magic     = 0x53415031
    type      = HANDSHAKE (1)
    codec     = 0xFF (Handshake)
    userId    = "roomId:userId"
    dataSize  = 0 (HANDSHAKE 无 payload)
    ...其他字段保留
}
```

客户端发送 HANDSHAKE 包到对端，以触发对端接收，从而在双方都向对方地址发包的情况下绕过对称 NAT。

---

## 帧同步与时序

- 默认每帧 5 ms（240 samples），接收端按 `sequence` 序号判断顺序
- 服务器混音模式下，服务器以 5ms 定时器周期触发混音并广播

### 音频 RTT 测量

`timestamp` 字段用于端到端音频延迟测量：

1. **客户端发送**: 写入 `currentTimeMs & 0xFFFF`（本地毫秒低 16 位）
2. **服务器透传**: 记录每个房间最近收到的 timestamp，混音广播时原样写入返回包
3. **客户端接收**: `RTT = (currentMsLow16 - rxTimestamp) & 0xFFFF`，带 EMA 平滑

16 位可覆盖 0~65535ms 范围，远超实际延迟。客户端丢弃 >10000ms 的异常值。
此机制零额外带宽开销（复用已有的空闲字段），测量的是真实音频通路延迟而非信令通道延迟。

---

## 信令消息（TCP JSON）

信令通道用于房间管理（创建/加入/离开）和 P2P SDP 交换。所有消息为单行 JSON，结尾以 `\n` 分隔。

### 客户端 → 服务器

#### `CREATE_ROOM` — 创建房间
```json
{
  "type": "CREATE_ROOM",
  "room_id": "room_abc123",
  "user_id": "user_jane"
}
```

#### `JOIN_ROOM` — 加入房间（同时携带本地 UDP 地址）
```json
{
  "type": "JOIN_ROOM",
  "room_id": "room_abc123",
  "user_id": "user_john",
  "ip": "192.168.1.100",
  "port": 5000
}
```
> `ip` / `port` 为客户端监听 UDP 的地址，供 P2P 打洞使用。

#### `LEAVE_ROOM` — 离开房间
```json
{
  "type": "LEAVE_ROOM",
  "room_id": "room_abc123",
  "user_id": "user_john"
}
```

#### `P2P_OFFER` — 发起 P2P 连接（WebRTC SDP offer）
```json
{
  "type": "P2P_OFFER",
  "room_id": "room_abc123",
  "from_user": "user_jane",
  "to_user": "user_john",
  "sdp": "v=0\r\no=..."
}
```

#### `P2P_ANSWER` — 响应 P2P 连接（WebRTC SDP answer）
```json
{
  "type": "P2P_ANSWER",
  "room_id": "room_abc123",
  "from_user": "user_john",
  "to_user": "user_jane",
  "sdp": "v=0\r\no=..."
}
```

#### `P2P_ICE` — 交换 ICE 候选
```json
{
  "type": "P2P_ICE",
  "room_id": "room_abc123",
  "from_user": "user_jane",
  "to_user": "user_john",
  "candidate": "candidate:1 1 UDP 2122252543 192.168.1.100 5000 typ host"
}
```

#### `HEARTBEAT` — 保活
```json
{
  "type": "HEARTBEAT",
  "user_id": "user_jane"
}
```
> 建议每 30 秒发送一次。

#### `MIXER_REGISTER` — WebRTC mixer proxy 注册
```json
{
  "type": "MIXER_REGISTER"
}
```
> webrtc-mixer-proxy 连接到信令服务器后发送，注册自身以接收 SDP/ICE 转发。

#### `MIXER_OFFER` — 浏览器发送 WebRTC SDP offer
```json
{
  "type": "MIXER_OFFER",
  "user_id": "user_jane",
  "sdp": "v=0\r\no=..."
}
```
> 信令服务器原样转发给已注册的 mixer proxy。

#### `MIXER_ICE` — 浏览器发送 ICE 候选
```json
{
  "type": "MIXER_ICE",
  "user_id": "user_jane",
  "candidate": "candidate:1 1 UDP ...",
  "sdpMid": "0"
}
```
> 信令服务器原样转发给 mixer proxy。

#### `MIXER_ANSWER` — mixer proxy 返回 SDP answer（由 proxy 发送）
```json
{
  "type": "MIXER_ANSWER",
  "target_user_id": "user_jane",
  "sdp": "v=0\r\no=..."
}
```
> 信令服务器按 `target_user_id` 转发给对应浏览器。

#### `MIXER_ICE_RELAY` — mixer proxy 返回 ICE 候选（由 proxy 发送）
```json
{
  "type": "MIXER_ICE_RELAY",
  "target_user_id": "user_jane",
  "candidate": "candidate:1 1 UDP ...",
  "sdpMid": "0"
}
```
> 信令服务器按 `target_user_id` 转发给对应浏览器。

### 服务器 → 客户端

#### `CREATE_ROOM_ACK` — 创建房间确认
```json
{
  "type": "CREATE_ROOM_ACK",
  "room_id": "room_abc123",
  "user_id": "user_jane",
  "success": true
}
```

#### `JOIN_ROOM_ACK` — 加入房间确认（含当前房间成员列表）
```json
{
  "type": "JOIN_ROOM_ACK",
  "room_id": "room_abc123",
  "user_id": "user_john",
  "success": true,
  "peers": [
    { "user_id": "user_jane", "ip": "192.168.1.101", "port": 5000 }
  ]
}
```

#### `PEER_LIST` — 房间成员列表（其他成员加入后主动推送）
```json
{
  "type": "PEER_LIST",
  "room_id": "room_abc123",
  "peers": [
    { "user_id": "user_jane", "ip": "192.168.1.101", "port": 5000 },
    { "user_id": "user_bob",  "ip": "10.0.0.5",      "port": 5001 }
  ]
}
```

#### `PEER_JOINED` — 新成员加入通知
```json
{
  "type": "PEER_JOINED",
  "room_id": "room_abc123",
  "peer": { "user_id": "user_bob", "ip": "10.0.0.5", "port": 5001 }
}
```

#### `PEER_LEFT` — 成员离开通知
```json
{
  "type": "PEER_LEFT",
  "room_id": "room_abc123",
  "user_id": "user_bob"
}
```

#### `ERROR` — 错误响应
```json
{
  "type": "ERROR",
  "room_id": "room_abc123",
  "user_id": "user_john",
  "message": "Room is full"
}
```

---

## 传输架构

```
┌─────────────┐         TCP (信令)          ┌──────────────────┐
│  Desktop    │◄────────────────────────────►│  Signaling Server│
│  Client A   │                             │  (uv TCP)        │
└──────┬──────┘                             └────────┬─────────┘
       │                                               │
       │  UDP (SPA1 音频)                              │ TCP (JSON)
       │  P2P Mesh 或                                │
       │  Mixer Server                               │
       ▼                                              ▼
┌─────────────┐         UDP (SPA1 音频)          ┌──────────────────┐
│  Desktop    │◄────────────────────────────►│  Mixer Server    │
│  Client B   │        (混音后回传)          │  (uv UDP)        │
└─────────────┘                             └──────────────────┘
```

### 传输路径说明

| 场景 | 传输路径 | 说明 |
|------|----------|------|
| P2P 模式（2-4人）| Client → Client（直连 UDP）| Mesh 网状拓扑，每对成员直连 |
| Mixer 模式（≥5人或 P2P 失败）| Client → Server → Client（混音后回传）| 星形拓扑，服务器混音后分发 |

---

## 版本历史

| 版本 | 头长 | userId | 变更 |
|------|------|--------|------|
| v1.0 | 44 字节 | 32 字节 | 初始版本 |
| v1.0a | 44 字节 | 30 字节 | 新增 type、level 字段（已废弃） |
| **P1-1** | **76 字节** | **64 字节** | userId 扩展至 64 字节，移除 type/level 字段，电平改为 TCP LEVELS 消息 |
| **P1-2** | 76 字节 | 64 字节 | timestamp 字段改为客户端 RTT 测量用途（服务器透传） |

---

## 实现参考

- **服务端头文件**：`server/src/mixer_server.h` — `struct SPA1Packet`
- **Web 客户端**：`web/src/services/audioService.ts` — `buildSpa1Packet()` / `parseSpa1Header()`
- **WebRTC 代理**：`web/webrtc-mixer-proxy.js` — SPA1 userId 解析（UDP 路由）
- **常量定义**：
  - `SPA1_MAGIC = 0x53415031`
  - `SPA1_CODEC_PCM16 = 0`
  - `SPA1_CODEC_OPUS = 1`
  - `SPA1_HEADER_SIZE = 76`（P1-1）
  - `MAX_PAYLOAD_SIZE = 1356`（dataSize 上限）
