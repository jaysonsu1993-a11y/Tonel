# SPA1 — Simple Protocol for Audio v1

> 对应实现头文件：`Tonel-Desktop/spa1.h`

## 概述

SPA1 是一个为实时排练场景设计的轻量级二进制音频协议。采用 UDP 传输（音频流）和 TCP 传输（信令消息）。所有多字节字段均采用网络字节序（大端序）。

---

## 包格式（44 字节固定头 + payload）

```
偏移  大小  类型       字段         说明
──────────────────────────────────────────────────────────────
0     4     u32 BE    magic       0x53415031 ('SPA1')
4     2     u16 BE    sequence    包序号（递增）
6     2     u16 BE    timestamp   播放时间戳（ms，服务器使用）
8     30    char[]    userId      用户标识符，最大 29 字符 + null 终止
38    1     u8        type        0=AUDIO, 1=HANDSHAKE
39    1     u8        codec       0=PCM16, 1=Opus（仅 AUDIO）
40    1     int8      level       音频电平 dBFS（仅 AUDIO，服务器计算）
41    2     u16 BE    dataSize    payload 字节数
43    1     u8        reserved    保留 / 未来扩展标志位
──────────────────────────────────────────────────────────────
44+   N     uint8[]   data        音频数据
──────────────────────────────────────────────────────────────
      ── 总头长：44 字节 ──
```

### 各字段详解

| 字段 | 类型 | 说明 |
|------|------|------|
| `magic` | u32 | 固定值 `0x53415031`，用于协议识别与校验 |
| `sequence` | u16 | 包序号，每包递增，接收端用于检测丢包和排序 |
| `timestamp` | u16 | 播放时间戳（ms），服务器混音时用于同步 |
| `userId` | char[30] | 格式 `"roomId:userId"`，null 终止 |
| `type` | u8 | 消息类型：`0=AUDIO`（音频数据），`1=HANDSHAKE`（地址注册） |
| `codec` | u8 | 音频编码器：`0=PCM16`（无压缩），`1=Opus`（有损压缩） |
| `level` | int8 | 服务器计算的当前帧电平，`level_dBFS = (int8_t)level`，范围 -127～0 dBFS |
| `dataSize` | u16 | `data` payload 的实际字节数 |
| `reserved` | u8 | 保留字段，置 0 |

### level 字段电平参考

| level 值 | dBFS | 说明 |
|----------|------|------|
| 0 | 0 dBFS | 满刻度（ clipping 临界点） |
| -6 | -6 dBFS | 动态余量充足，信号偏热但干净 |
| -18 | -18 dBFS | 典型工作电平 |
| -36 | -36 dBFS | 弱奏段落 |
| -127 | -127 dBFS | 近静默阈值 |
| >0 | >0 dBFS | 信号已 clipping，需降低增益 |

---

## 支持的 Codec

| 值 | 名称 | 格式 | 说明 |
|----|------|------|------|
| `0x00` | PCM16 | 48kHz / 16bit / mono / 无压缩 | 适合低延迟本地网络 |
| `0x01` | Opus | 有损压缩（可变码率） | 适合互联网传输，降低带宽 |
| `0xFF` | Handshake | — | 用于 UDP 打洞地址注册（见下方） |

### PCM16 帧结构

- 帧长：**20 ms** = 960 samples @ 48kHz
- 每帧字节数：960 × 2 = **1920 bytes**
- 这是最大帧长；实际包可能小于此值（如静音段）

### Opus 帧结构

- 帧长：同样是 **20 ms**
- 每帧字节数：可变，典型约 **80–120 bytes**（取决于比特率设置）
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

- 每帧 20 ms，接收端按 `sequence` 序号和 `timestamp` 双重判断顺序
- 服务器混音模式下，`timestamp` 由服务器统一填写，用于客户端播放同步
- P2P 模式下，`timestamp` 由发送端填写（通常为本地时钟）

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

## 与旧版 SPA1 v1.0 的差异

| 项目 | v1.0 | 当前版本 |
|------|------|---------|
| `userId` 字段大小 | 32 字节 | 30 字节（腾出空间给 type 和 level） |
| `type` 字段 | 无 | 新增 offset 38，区分 AUDIO / HANDSHAKE |
| `level` 字段 | 无 | 新增 offset 40，服务器计算 dBFS 电平 |
| `dataSize` 偏移 | 41-42 | 41-42（不变，但 level 插入了 codec 和 dataSize 之间） |

---

## 实现参考

- **头文件**：`Tonel-Desktop/spa1.h`
- **C++ 结构体**：`struct SPA1Packet`
- **常量定义**：
  - `SPA1_MAGIC = 0x53415031`
  - `SPA1_CODEC_PCM16 = 0`
  - `SPA1_CODEC_OPUS = 1`
  - `SPA1_TYPE_AUDIO = 0`
  - `SPA1_TYPE_HANDSHAKE = 1`
  - `SPA1_PCM16_FRAME_SIZE = 1920`
  - `SPA1_HEADER_SIZE = 44`
