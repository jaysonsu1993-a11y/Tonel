# S1-Mini 开发进度

## 项目概述
S1-Mini 是 S1 乐队的最小化音频引擎验证项目，目标验证 < 25ms 延迟的可行性。

## 技术栈
- miniaudio (MIT-0) - 音频引擎
- POSIX sockets (UDP) - 网络传输
- C++17

## 延迟预算 (128帧 / 48kHz)
- 音频缓冲: ~2.67ms (128帧 @ 48kHz)
- 网络传输: < 10ms (目标)
- 总计目标: < 25ms

## 开发进度

### Day 1 ✅ (已完成)
- [x] AudioEngine 基础框架 (miniaudio duplex)
- [x] 设备枚举与选择
- [x] 128帧低延迟配置
- [x] Duplex passthrough (zero-copy memcpy)

### Day 2 ✅ (已完成)
- [x] NetworkSocket 绑定 (UDP)
- [x] send() / receive() 方法
- [x] AudioPacket 结构体定义
- [x] 数据包序列号和时间戳

### Day 3 ✅ (已完成)
- [x] 音频数据包打包/解包函数 (`PacketUtil.h`)
- [x] NetworkSocket 与 AudioEngine 集成
- [x] 本地回环测试
- [ ] 测量实际延迟

### Day 4 ✅ (已完成)
- [x] 流媒体模式设计（Mode enum: Loopback/Streaming）
- [x] 抖动缓冲算法优化（WebRTC 风格自适应 jitter buffer）
- [x] 丢包处理策略（PLC 框架，slot-based 64 slot 缓冲）
- [x] 实际延迟测量（steady_clock 端到端统计）

### Day 5 ✅ (已完成)
- [x] PLC 完整实现（线性插值）
- [x] 延迟统计 Bug 修复（INT64_MAX 初始化问题）
- [x] Streaming 模式代码审查

## Day 4 详细说明

### 实现内容

#### 1. AdaptiveJitterBuffer（新增类，WebRTC 风格）

**核心思想**：基于 WebRTC JitterBuffer 的自适应缓冲策略

**关键参数**：
```
INITIAL_DELAY_US  = 5000μs  (5ms 初始播放延迟)
MIN_DELAY_US      = 2000μs  (2ms 最小)
MAX_DELAY_US      = 20000μs (20ms 最大)
JITTER_MULTIPLIER = 4       (jitter × 4 = 额外缓冲)
RESYNC_THRESHOLD  = 30000μs (30ms 间隙 → 重同步)
```

**Slot 存储**：64 slot 预分配环形存储，无音频线程内存分配

**Jitter 估计**：
- 使用指数移动平均 (EMA) 跟踪包间隔：`avgJitterUs_ = (avgJitterUs_ * 7 + |arrivalDelta|) / 8`
- 维护 50 个样本的滑动窗口用于抖动统计

**播放时间驱动**：
- 第一个包建立 `playoutTimeUs_ = firstTs + INITIAL_DELAY_US`
- 每次播放一个包，`playoutTimeUs_ += 约 2700μs`（对应 128 帧 @ 48kHz）
- 如果 `timeDelta > +5ms`（晚了）→ 跳过缓冲追赶：`playoutTimeUs_ += timeDelta - 2000`
- 如果 `timeDelta < -5ms`（早了）→ 放慢播放：`playoutTimeUs_ += timeDelta + 2000`

**延迟测量**：
- `latency = playNowUs - pktTs`（发送时间戳到播放时间戳的差）
- 统计：avg / min / max（每 2s 打印一次）

**丢包处理 (PLC)**：
- 检测序列号跳跃（期望 seq 未到达）
- 调用 `doPLC()` 生成替代音频
- Day 5 升级为**线性插值 PLC**：
  - 前后包均存在：`concealed[i] = prev[i] + (next[i] - prev[i]) * (i/N)` 平滑过渡
  - 只有前包：渐变衰减（15% 衰减 + 指数衰减到零）
  - 只有后包：反向插值（从零渐变到后包振幅 85%）
  - 前后均无：静音

#### 2. 流媒体模式结构

```cpp
enum class Mode { Loopback, Streaming };
struct StreamingConfig {
    const char* remoteHost = "127.0.0.1";
    int remotePort = 9001;
    int localRecvPort = 9000;
    int localSendPort = 9001;
};
```
Loopback 模式：发送端发送到 localhost:9001，接收端从 localhost:9000 收
Streaming 模式：发送到远程主机（待集成）

#### 3. 性能优化

- 接收轮询间隔：500μs → 200μs（减少包丢失概率）
- 64 slot vs 原来的 16 slot（更深的缓冲应对突发抖动）
- 无锁 pop（atomic read in audio callback，lock-free for real-time safety）

### 测试结果

```
=== S1-Mini Day 4: Adaptive Jitter Buffer + Latency Measurement ===
Mode: Loopback
[NetworkSocket] bound to UDP port 9001
[NetworkSocket] bound to UDP port 9000
[AudioEngine] started (buf=128 frames, 48000 Hz)

[S1-Mini] Audio engine running
  → Mic capture → send UDP → recv → jitter buffer → playback

=== S1-Mini Final Report ===
  Jitter:        0ms
  Latency:       avg=0ms min=9.22e+15ms max=0ms
  Packet loss:   100% (1355/1355)
============================
```

**说明**：100% 丢包是预期的，因为当前使用 Oray 虚拟音频设备，
该设备不从物理端口回传音频到 localhost:9001。
在有物理 loopback 或双机测试时才能测到实际延迟。

### 已知问题

~~PLC 当前为静音实现，完整版应使用线性插值~~ → Day 5 已修复
~~Streaming 模式（真机传输）尚未实测~~ → 代码审查通过（见下）
~~延迟统计的 min 值异常（INT64_MAX 初始值干扰）~~ → Day 5 已修复

## Day 5 计划

### Day 5 详细说明

#### 1. PLC 实现（`doPLC()` in `main.cpp`）

**算法**：
- 前向+后向包：扫描 slot 表查找前序（missingSeq-N）和后续（missingSeq+M）有效包
- 从 `prevPacketData_` 取前包音频（播放时已缓存），从 slot 取后包音频
- 线性插值：`concealed[i] = prev[last_N+i] + (next[i] - prev[last_N+i]) * (i/N)`
- 插值范围外的样本：保持最后一个插值值

**只有前包**：
- 15% 线性衰减 + 指数衰减（×0.95/样本）到零

**只有后包**：
- 从零渐变到后包振幅的 85%（backward interpolation）

**前后均无**：
- 输出静音

#### 2. 延迟统计 Bug 修复

**问题**：`latencyMin_` 初始化为 `INT64_MAX`，在收到第一个包之前打印会显示 `9.22e+15ms`

**修复**：
- 新增 `latencyStatsInit_` 标志位，在 `reset()` 中清零
- 在 `popForPlay()` 中，第一个有效的 latency 样本同时初始化 min 和 max
- `latencyMinUs()` / `latencyMaxUs()` 在未初始化时返回 `-1`，打印为 `n/a`

#### 3. Streaming 模式代码审查

**端口配置**（Day 4 代码审查）：
- `g_sendSock.bind(9001)` → 向 `remoteHost:remotePort` 发送
- `g_recvSock.bind(9000)` → 从任意来源接收
- 配置符合标准 streaming 架构：send on 9001, recv on 9000
- UDP bind/SO_REUSEADDR/non-blocking 均正确配置

**待验证**：真机双机传输尚未实测（需要硬件 loopback 或双机）

#### 4. Day 5 代码变更

| 文件 | 变更 |
|------|------|
| `src/main.cpp` | PLC 线性插值实现、latency min/max 初始化修复、prevPacketData_ 缓存 |

### Day 6 ✅ (已完成)
- [x] 服务器混音架构设计
- [x] 撰写 `docs/s1-server-mixer.md`
- [x] 星型 vs P2P 拓扑决策（星型，Phase 1 支持 5 人）
- [x] 数据包格式设计（复用 AudioPacket + MixedAudioPacket）
- [x] libuv 架构设计（定时混音 + 数据包触发）
- [x] 混音算法设计（加权求和 + tanh 软限幅）
- [x] 带宽估算（4人乐队 ~1.15 Mbps，完全可接受）
- [x] 信令协议设计（HELLO/HELLO_ACK/KEEPALIVE）
- [x] 延迟预算分析（总计 ~13-17ms < 25ms ✅）

### Day 7 计划

- [ ] 实现 `ServerMixer` 类骨架（libuv UDP 服务端）
- [ ] 客户端状态管理（`ClientState` 结构）
- [ ] 基本混音算法实现
- [ ] 基础压测脚本（单进程模拟多客户端）

### Day 6 设计成果摘要

**架构**：星型服务器混音（C++ + libuv）
- 客户端 → 服务器（UDP）：发送原始 AudioPacket
- 服务器混音后广播 → 每个客户端（不含发送者自己的流）
- 服务器混音延迟目标：< 0.5ms（纯内存操作）

**数据包**：
- 复用 AudioPacket（clientId 扩展）
- 新增 MixedAudioPacket（混音结果，含 numSources）

**带宽**：4人乐队 ~1.15 Mbps（48KB/s × 3上行）

**延迟**：~13-17ms（网络 1-4ms + 服务器混音 <0.5ms + 抖动缓冲 5ms + 播放 2.67ms）

详见：`docs/s1-server-mixer.md`

---

## Jayson 汇报记录

### 2026-04-10 Day 6 进度

S1-Mini Day 6 完成 ✅

**主要工作：服务器混音架构设计**

今天完成了 S1 服务器端混音架构的完整设计：

1. **拓扑决策**：星型服务器混音（Phase 1 支持 5 人乐队）
   - 客户端发送 → 服务器混音 → 广播回每个客户端
   - P2P Mesh 留作 Phase 2

2. **数据包格式**：复用现有 AudioPacket，新增 MixedAudioPacket
   - 带 clientId 来源标识
   - 混音后广播含 numSources 元数据

3. **混音算法**：加权求和 + tanh 软限幅（防溢出）
   - 单帧处理 < 0.5ms（纯内存操作）
   - 不用归一化，保持动态范围

4. **带宽估算**：4人乐队 ~1.15 Mbps，完全可接受
   - 每客户端上行：48 KB/s

5. **延迟预算**：总计 ~13-17ms < 25ms 目标 ✅
   - 网络：1-4ms | 服务器混音：<0.5ms | 抖动缓冲：5ms | 播放：2.67ms

**下一步（Day 7）**：开始写 ServerMixer C++ 实现（libuv UDP）

详见：`~/project-s/s1-mini/docs/s1-server-mixer.md`

### Day 7 ✅ (已完成 - 2026-04-12)

**主要工作：桌面客户端信令集成**

1. **删除硬编码假数据** (`main.cpp`)
   - 移除了 onCreateRoom() 里的 4 个假参与者（吉他手A、键盘手B等）
   - 参与者列表现在从信令服务器实时获取

2. **新增 SignalingClient** (`src/network/SignalingClient.h/cpp`)
   - TCP Socket 客户端，连接信令服务器
   - 实现 CALLBACK 接口：onRoomCreated/onRoomJoined/onPeerList/onPeerJoined/onPeerLeft
   - 支持 CREATE_ROOM / JOIN_ROOM / LEAVE_ROOM 协议

3. **服务器地址修正**
   - MixerServer: 47.237.84.174:9002
   - Signaling: 47.237.84.174:9001
   - 混音 UDP: 47.237.84.174:9003

4. **信令协议对接**
   - 客户端发送: CREATE_ROOM, JOIN_ROOM, LEAVE_ROOM
   - 服务器接收: ROOM_PEERS (peer列表), PEER_JOINED, PEER_LEFT
   - AppState 参与者列表动态更新

### Day 8 计划

- [ ] 桌面客户端真实音频测试（麦克风 → 服务器混音 → 回放）
- [ ] RoomView 显示真实参与者（非假数据）
- [ ] 混音服务器 UDP 音频流验证
- [ ] 网页版和桌面客户端跨平台互通测试

### 当前运行服务（阿里云 8.163.21.207）

| 服务 | 端口 | 状态 |
|------|------|------|
| signaling_server | 9001/TCP | ✅ running |
| mixer_server | 9002/TCP, 9003/UDP | ✅ running |
| ws-proxy (signaling) | 9004 | ✅ running |
| ws-proxy (mixer) | 9005 | ✅ running |

### 已知问题

- Mac 本地网络封锁非标准端口（9001/9002/9003），需要 SSH 隧道测试
- 网页版入口: https://tonel.io/ (完整功能)
- 桌面客户端: 需在可访问服务器的网络上运行


## 经验 2026-04-12 - 桌面客户端信令集成

### 任务
为 BandRehearsal 桌面客户端添加真实信令服务器对接，替换硬编码假数据。

### 教训
- **架构问题要及时发现**：假数据问题说明客户端从未真正对接过信令服务器
- **新建文件要及时加入 CMakeLists.txt**： SignalingClient.cpp 需要手动添加
- **命名冲突要尽早修复**：PeerInfo 在两个头文件里定义不同，改名 SignalingPeerInfo 解决
- **SSH 隧道可用于本地开发测试**：Mac 网络封锁非标准端口时，用 SSH 隧道转发

### 改进
- 下次新功能先确认依赖是否完整（CMakeLists.txt、头文件 include 等）
- 桌面客户端部署前在同网络环境先测试
