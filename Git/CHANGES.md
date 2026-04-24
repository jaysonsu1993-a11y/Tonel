# Tonel 变更记录

---

## v0.3.4 — 2026-04-24

**变更类型**：Bug 修复

### 1. 修复：空房间未自动销毁（server）

**问题**：当房间内最后一个用户离开时，房间对象仍保留在 `RoomManager` 内存中，不会被清理。长期运行后会导致内存泄漏，且 `LIST_ROOMS` 会返回已废弃的空房间。

**修复**：在 `RoomManager::leave_room()` 中，用户移除后检查 `user_count() == 0`，如果房间为空则立即从 `rooms_` map 中擦除并记录日志。

||| 文件 | 改动 |
|||------|------|
||| `server/src/room.cpp` | `leave_room` 增加空房间检测与自动销毁 |

---

## v0.3.3 — 2026-04-22

**变更类型**：安全增强 + 文档修正

### 1. 安全：服务端房间密码改用 PBKDF2-HMAC-SHA256 哈希（server）

**问题**：房间密码以明文形式存储在服务端内存中，任何能访问服务器的人员均可读取所有房间密码。

**修复**：引入 `PasswordHasher` 工具类，使用 OpenSSL 实现标准 PBKDF2-HMAC-SHA256：
- 16 字节随机 salt（`RAND_bytes` 主要源，回退 `std::random_device`）
- 10000 次迭代
- 32 字节 SHA-256 输出
- 存储格式：`base64(salt):base64(hash)`
- 验证时采用常量时比较，防止时序攻击

|| 文件 | 改动 |
||------|------|
|| `server/src/password_hasher.h` | 新增 PBKDF2 哈希/验证头文件 |
|| `server/src/password_hasher.cpp` | 新增实现（含 base64 编码、OpenSSL PKCS5_PBKDF2_HMAC） |
|| `server/src/room.h` | `password_` → `password_hash_`，`check_password` 改为调用 `PasswordHasher` |
|| `server/src/room.cpp` | 完整重写，适配哈希比较接口 |
|| `server/src/signaling_server.cpp` | `CREATE_ROOM` 时对密码进行哈希后再存储 |
|| `server/CMakeLists.txt` | 查找并链接 OpenSSL::Crypto |

**注意**：本次修复仅保障密码存储安全，传输层仍为明文 TCP，建议后续引入 TLS。

### 2. 规范：config.schema.json 字段命名与编码规范对齐（含解析器同步）

**问题**：`config.schema.json` 中音频参数使用 camelCase（`sampleRate`、`bufferSize` 等），与 `STANDARDS_CODE.md` 要求的 JSON snake_case 不一致。

**修复**：
- `config.schema.json` 字段重命名：
  - `sampleRate` → `sample_rate`
  - `bufferSize` → `buffer_size`
  - `inputChannels` → `input_channels`
  - `outputChannels` → `output_channels`

**附加修复**：发现服务端和桌面端配置解析器仍在使用旧的 camelCase 键名，而实际 `config.json` 已是 snake_case，导致所有自定义配置值被静默忽略、回退到默认值。

- `server/src/config.cpp`：同步更新所有 JSON 键名（含 `signalingPort` → `signaling_port`、`mixerPort` → `mixer_port`、`appId` → `id`）
- `Tonel-Desktop/src/ConfigManager.cpp`：同步更新音频配置键名

### 3. 文档：重写 s1-server-mixer.md 与实际实现一致

**问题**：设计文档 v1.0 已部分过时，与实际代码不一致。

**修复**：
- AudioPacket magic：`0x53410001` → `0x53415031`（SPA1）
- 混音控制协议：UDP 扩展包 → TCP JSON（MIXER_JOIN / MIXER_LEAVE）
- 更新文件结构以匹配当前源码布局
- 更新实现状态（Phase 1/2 完成，Phase 3/4 进行中）
- 添加协议版本历史表

---

## v0.3.2 — 2026-04-19

**变更类型**：Bug 修复（Web 黑屏）

### 1. 修复：有人加入房间时 Web 端黑屏（`web/src/services/signalService.ts`）

**问题**：任何人加入房间时，Web 端当前在房间内的用户界面会变成黑屏。

**根本原因**：服务端 `PEER_JOINED` 消息格式为扁平结构（`user_id`、`ip`、`port` 位于顶层），但 Web 客户端的 `SignalMessage` 类型将其定义为嵌套结构（`peer: { user_id, ip, port }`）。`useSignal.ts` 中访问 `m.peer.user_id` 时 `m.peer` 为 `undefined`，抛出 `TypeError`，React 渲染崩溃 → 黑屏。

**修复**：在 `signalService.ts` 的 `onmessage` 解析层统一将扁平格式规范化为嵌套 `peer` 对象，不更改服务端协议及 AppKit 解析逻辑。

| 文件 | 改动 |
|------|------|
| `web/src/services/signalService.ts` | `onmessage` 中检测 `PEER_JOINED` 消息，将 `{user_id, ip, port}` 包装为 `{peer: {user_id, ip, port}}` |

---

## v0.3.1 — 2026-04-19

**变更类型**：Bug 修复（服务端崩溃）

### 1. 修复：Web 端退出房间导致信令服务器崩溃，所有用户被踢出

**问题**：用户从 Web 端退出房间后，同一房间的 AppKit 客户端也会被强制断开。PM2 日志显示 `double free or corruption (top)`，说明信令服务器在处理连接关闭时触发堆内存损坏并崩溃，pm2 重启后所有 TCP 连接重置，所有客户端被踢出。

**根本原因（两处）**：

1. `on_read`（EOF 时）将 `stream->data` 置为 `nullptr` **然后**再调用 `uv_close` → `on_close` 收到 null context，直接返回，`ClientContext` 内存泄漏，**且 User 对象从未从 `user_manager_` 中移除**。
2. 约 30 秒后，`check_timeouts` 定时器发现该 User 仍在 `user_manager_` 中，再次对同一 handle 调用 `uv_close` → **二次关闭同一 libuv handle → 堆损坏 → 崩溃**。

**修复**：

| 文件 | 改动 |
|------|------|
| `server/src/signaling_server.cpp` | `on_read`：移除 `stream->data = nullptr`，改用 `uv_is_closing()` 防止二次关闭 |
| `server/src/signaling_server.cpp` | `on_close`：修复 ctx 泄漏（任何路径都执行 `delete ctx`）；添加 `PEER_LEFT` 广播 |
| `server/src/signaling_server.cpp` | `process_leave_room`：立即调用 `remove_user_no_close` + 清空 `ctx->user_id`，防止 `check_timeouts` 触发二次关闭；添加 `PEER_LEFT` 广播 |
| `server/src/signaling_server.cpp` | `start()` 中 `on_user_remove_` 回调：添加 `uv_is_closing()` 防护 |

**附加改进**：服务端现在会在用户离开房间（无论主动 LEAVE_ROOM 还是 TCP 断连）时向房间内其他成员广播 `PEER_LEFT`，成员列表可实时更新。

---

## v0.3.0 — 2026-04-19

**变更类型**：功能改进

### 1. Web 端创建房间支持自定义房间号（`web/src/pages/HomePage.tsx`）

**背景**：AppKit 客户端创建房间时有房间号输入框，可自定义或留空自动生成。Web 端仅自动生成随机 ID，只读展示，无法自定义，两端行为不一致导致无法互通指定房间。

**修复**：将"创建房间"面板中的只读 `room-id-preview` 展示块替换为可编辑的 `<input>`，行为与 AppKit 客户端完全一致：
- 输入自定义房间号 → 使用该房间号
- 留空 → 自动生成随机 6 位字母数字 ID

| 文件 | 改动 |
|------|------|
| `web/src/pages/HomePage.tsx` | 创建面板增加房间号输入框，`handleCreateConfirm` 留空时自动生成 ID |

---

## v0.2.4 — 2026-04-19

**变更类型**：Bug 修复

### 1. 修复：AppKit 客户端按钮点击无响应（`S1RoundedButton.mm`）

**问题**：`hitTest:` 收到的 `point` 参数在父视图的坐标空间中，但代码直接用 `NSPointInRect(point, self.bounds)` 比较。按钮的实际 `frame.origin` 不是 `(0,0)`（由 autolayout 定位），导致传入的 point（如 `(474,300)`）始终不在 `bounds(0,0,240,52)` 内，`hitTest` 返回 `nil`，所有按钮点击事件被丢弃。

**修复**：使用 `[self convertPoint:point fromView:self.superview]` 将 point 转换到按钮自身坐标系后再判断。

```objc
// 修复前
NSView* result = NSPointInRect(point, self.bounds) ? self : nil;

// 修复后
NSPoint localPoint = [self convertPoint:point fromView:self.superview];
NSView* result = NSPointInRect(localPoint, self.bounds) ? self : nil;
```

### 2. 修复：signaling server `double free or corruption` 崩溃（`server/src/signaling_server.cpp`、`user.h`、`user.cpp`）

**问题**：当客户端连接断开时，`on_read` 调用 `uv_close` 触发 `on_close`。但心跳超时检查（`check_timeouts`）的 `on_user_remove_` 回调也会触发 `uv_close` → 同一 handle 被 `uv_close` 两次，`on_close` 第二次执行时 `ctx` 已被释放，触发 `double free` 崩溃，服务器被 pm2 无限重启。

**修复**：
1. `on_read` 中在调用 `uv_close` 前先设置 `stream->data = nullptr`，使 `on_close` 第二次执行时直接返回（幂等）
2. `on_close` 中使用 `remove_user_no_close()` 代替 `remove_user()`，避免在关闭连接时再次触发 uv_close
3. `process_leave_room` 将 `user_manager_.remove_user()` 延迟到连接实际关闭的 `on_close` 中执行，消除多条清理路径的重叠

| 文件 | 改动 |
|------|------|
| `server/src/signaling_server.cpp` | `on_read` 置空 `stream->data`；`on_close` 使用 `remove_user_no_close`；`process_leave_room` 延迟清理 |
| `server/src/user.h` | 新增 `remove_user_no_close()` 方法声明 |
| `server/src/user.cpp` | 实现 `remove_user_no_close()` |

| 文件 | 改动 |
|------|------|
| `Tonel-Desktop-AppKit/src/ui/S1RoundedButton.mm` | `hitTest:` 增加坐标转换 |
| `server/src/signaling_server.cpp` | 修复连接关闭时的双重释放崩溃 |
| `server/src/user.h` | 新增 `remove_user_no_close()` |
| `server/src/user.cpp` | 实现 `remove_user_no_close()` |

### 3. 修复：ws-proxy 频繁崩溃 & 加固错误处理（`server/ws-proxy.js`）

**问题**：ws-proxy 进程频繁崩溃（PM2 重启 12+ 次），导致 9004 端口无监听 → nginx 返回 400 → AppKit 客户端无法创建/加入房间。

**修复**：
1. 所有 `ws.close()` 和 `ws.send()` 包裹 try/catch
2. `tcpClient.writable` 检查后再 write，防止向已关闭的 socket 写数据
3. 新增 `uncaughtException` handler 防止 PM2 崩溃循环
4. 每个 WebSocket 连接分配唯一 connId，方便日志追踪

### 4. 修复：创建/加入房间无响应（`MainWindowController.mm`、`S1SignalingClient.mm`）

**问题一：无错误反馈**

点击"创建"后，若信令服务器连接失败（服务端宕机、网络不通等），`networkBridgeError:` 和 `networkBridgeDisconnected` 回调仅打印日志，不跳转、不弹窗，用户界面毫无反应，停在创建房间页面。

**修复**：在两个回调中，若当前有 `pendingAction`（等待创建/加入房间），弹出错误提示并返回主页。

```objc
- (void)networkBridgeError:(NSString*)error {
    if (self.pendingAction != PendingRoomActionNone) {
        self.pendingAction = PendingRoomActionNone;
        dispatch_async(dispatch_get_main_queue(), ^{
            // 弹出错误 Alert → showHome
        });
    }
}
```

**问题二：WebSocket 握手被 ws 库拒绝（400 Bad Request）**

`S1SignalingClient.mm` 使用 `[sess webSocketTaskWithURL:url protocols:@[]]`。`protocols:@[]`（空数组）导致 NSURLSessionWebSocketTask 发送 `Sec-WebSocket-Protocol: `（空值）请求头。ws npm 库 v8 在解析 `Sec-WebSocket-Protocol` 时，若存在空字符串协议名，会直接返回 `HTTP 400 Bad Request`，握手失败。

通过 nginx debug 日志确认：400 来自 ws-proxy（上游），非 nginx 自身。

**修复**：改用不传 protocols 参数的重载，不发送 `Sec-WebSocket-Protocol` 头。

```objc
// 修复前
NSURLSessionWebSocketTask* task = [sess webSocketTaskWithURL:url protocols:@[]];

// 修复后
NSURLSessionWebSocketTask* task = [sess webSocketTaskWithURL:url];
```

| 文件 | 改动 |
|------|------|
| `Tonel-Desktop-AppKit/src/MainWindowController.mm` | `networkBridgeError:` 和 `networkBridgeDisconnected` 增加 pending action 错误提示 |
| `Tonel-Desktop-AppKit/src/bridge/S1SignalingClient.mm` | WebSocket task 创建去掉空 protocols 参数 |

---

## v0.2.3 — 2026-04-18

**变更类型**：Bug 修复

### 1. 修复：信令服务器 double free 崩溃（`server/src/signaling_server.cpp`）

**问题**：`on_read` 在 `nread < 0`（连接断开）时先调用 `handle_read(stream, nread, buf)`，`handle_read` 内部释放了 `buf->base`；`handle_read` 返回后，`on_read` 再次执行 `if (nread < 0) delete[] buf->base`，同一块内存被释放两次，触发 `double free or corruption`，服务器每次有客户端断开都会崩溃并被 pm2 重启。

**修复**：删除 `handle_read` 内 `nread < 0` 分支对 `buf->base` 的释放，由 `on_read` 统一负责。

### 2. 修复：加入房间错误提示偶发不显示（`web/src/services/signalService.ts`）

由三个独立问题共同导致"有时无提示"：

| 问题 | 现象 | 修复 |
|------|------|------|
| `send()` 返回 void，连接未就绪时静默丢包 | Promise 挂起直到 8 秒超时才报错 | `send()` 改为返回 `bool`；`sendAndWait` 检测后立即 reject |
| 等待 ACK 期间连接断开无处理 | 同上，挂起 8 秒 | `sendAndWait` 新增 `ws.onclose` 监听，断开立即 reject |
| WebSocket 处于 CONNECTING 状态时重复创建新连接 | 两个 WS 竞争，消息路由混乱 | 新增 `ensureConnected()`，CONNECTING 状态下等待现有连接就绪而非新建 |

### 3. 修复：房间号不足 4 位时静默忽略（`web/src/pages/HomePage.tsx`）

`handleJoin` 中 `if (roomId.trim().length < 4) return` 导致输入"23"等短房间号点击加入后无任何响应。改为最小长度 1，让服务器返回实际错误原因。

| 文件 | 改动 |
|------|------|
| `server/src/signaling_server.cpp` | `handle_read` nread<0 分支不再释放 buf |
| `web/src/services/signalService.ts` | `send()` 返回 bool；新增 `ensureConnected()`、`sendAndWait()` |
| `web/src/pages/HomePage.tsx` | 最小房间号长度从 4 改为 1 |

---

## v0.2.2 — 2026-04-18

**变更类型**：严重 Bug 修复

### 修复：音频接收路径完全失效（Web + Desktop 共 5 处）

本次修复的所有问题均导致混音服务器的输出音频**从未到达任何客户端**——发送正常，接收完全断链。

#### Web 端（3 个连环 bug）

**Bug 1 — 代理用错 socket 发包（`web/ws-mixer-proxy.js`）**

`udpSend` 没有绑定端口，OS 分配随机临时端口（如 54321）。服务器把混音音频回包发到 54321，而 `udpRecv` 绑在 9006，永远收不到。

修复：删除 `udpSend`，改用 `udpRecv.send()`（已绑定的 socket），服务器和代理共用同一端口。

**Bug 2 — 服务器回包 userId 写 "MIXER" 无法路由（`server/src/mixer_server.cpp`）**

代理的 `wsByUid` 以 `"roomId:userId"` 为 key，但服务器发回的包 userId 是 `"MIXER"`，`wsByUid.get("MIXER")` 永远是 undefined，包被丢弃。

修复：`broadcast_mixed_audio` 改写收件人的 `room->id + ":" + kv.first` 进 userId 字段。

**Bug 3 — `wsUdp` 没有 `onmessage` 处理器（`web/src/services/audioService.ts`）**

即使前两个 bug 都修好，代理把音频发到 `/mixer-udp` WebSocket，浏览器端 `wsUdp` 也没有 `onmessage`，音频被静默丢弃。

修复：`establishUdpRelay()` 添加 `wsUdp.onmessage = (evt) => handleMixerMessage(evt.data)`。

#### Desktop 端（2 个 bug）

**Bug 4 — 收包时 dataSize 读偏一字节（`Tonel-Desktop/src/network/MixerServerConnection.cpp`）**

`processReceivedPacket` 读 `(data[42] << 8) | data[43]`，正确应为 `(data[41] << 8) | data[42]`（大端序在 [41-42]）。读到的值远超实际，通过 sanity check 后越界，触发 `return`，服务器发来的**每一个包都被丢弃**。

**Bug 5 — 发包时 dataSize 写偏一字节（`Tonel-Desktop/src/network/MixerServerConnection.cpp`）**

`sendAudio` 写 `p[41]=0; p[42]=high; p[43]=low`，正确应为 `p[41]=high; p[42]=low; p[43]=0`。PCM16 模式服务器侧忽略 dataSize 所以侥幸工作，但 Opus 模式服务器用 dataSize 调 Opus 解码器，传入 0 导致完全失效。

| 文件 | 改动 |
|------|------|
| `web/ws-mixer-proxy.js` | 删除 `udpSend`，改用 `udpRecv.send()` |
| `server/src/mixer_server.cpp` | 回包 userId 改为 `room->id + ":" + kv.first` |
| `web/src/services/audioService.ts` | `wsUdp.onmessage` 接收混音音频 |
| `Tonel-Desktop/src/network/MixerServerConnection.cpp` | 收包 dataSize 读 [41-42]；发包 dataSize 写 [41-42]，[43]=0 |

---

## v0.2.1 — 2026-04-18

**变更类型**：Bug 修复

### 修复：加入房间前未校验房间是否存在

**问题**：用户在 Web 端输入任意房间号点击"加入"后，客户端立即跳转到 RoomPage，再由 RoomPage 发送 `JOIN_ROOM` 消息。服务器的校验结果（房间不存在、密码错误）返回时用户已处于房间页面：
- `'Incorrect room password'` 有专属 overlay 处理；
- `'Room not found'` 没有对应处理逻辑，页面停在无效的"空房间"状态，用户无任何提示。

**修改文件**：

| 文件 | 改动 |
|------|------|
| `web/src/services/signalService.ts` | `joinRoom` / `createRoom` 改为返回 Promise，等待 `JOIN_ROOM_ACK` / `CREATE_ROOM_ACK` 后 resolve，收到 `ERROR` 则 reject（10 秒超时） |
| `web/src/hooks/useSignal.ts` | `joinRoom` / `createRoom` 捕获错误后 re-throw，让上层可感知失败 |
| `web/src/App.tsx` | `handleJoinRoom` / `handleCreateRoom` 改为 async；等待服务器确认后再跳转；失败时设置 `joinError` / `createError` 传给 HomePage |
| `web/src/pages/HomePage.tsx` | 接收 `joinError` / `createError` 并在输入框下方显示红色错误文字；加入/创建期间禁用按钮并显示"连接中…" / "创建中…" |
| `web/src/pages/RoomPage.tsx` | 移除 `onJoinRoom` prop 及挂载后发送 `JOIN_ROOM` 的逻辑（加入已在导航前完成）；移除密码错误 overlay（错误现在统一在 HomePage 处理） |
| `web/src/styles/globals.css` | 新增 `.form-error` 样式（红色小字错误提示） |

**新流程**：
```
点击"加入" → 按钮灰显"连接中…" → 发送 JOIN_ROOM
  → JOIN_ROOM_ACK：跳转 RoomPage
  → ERROR：停在首页，输入框下方显示错误原因
```

---

## v0.2.0 — 2026-04-18

**变更类型**：新功能 + Bug 修复

### 1. Web 端房间密码功能

与 AppKit 客户端对齐，Web 端补充完整的密码支持。

| 文件 | 改动 |
|------|------|
| `web/src/services/signalService.ts` | `createRoom` / `joinRoom` 增加可选 `password` 参数，有值时附加到 JSON 消息 |
| `web/src/hooks/useSignal.ts` | 透传 `password`，新增对服务器 `ERROR` 消息的订阅与状态暴露 |
| `web/src/pages/HomePage.tsx` | 创建房间：点击后展开内联面板，显示生成的房间号 + 可选密码输入；加入房间：表单增加密码输入框 |
| `web/src/App.tsx` | 新增 `roomPassword` state，create/join 时存储并传给 `RoomPage` |
| `web/src/pages/RoomPage.tsx` | 接收 `password` prop，`JOIN_ROOM` 时携带；服务器返回密码错误时显示专属提示页 + 返回按钮 |
| `web/src/styles/globals.css` | 密码输入框样式（去掉 uppercase）、创建面板、错误覆盖页 |

### 2. 修复：连接断开时空房间未自动注销

**文件**：`server/src/signaling_server.cpp`，`on_close` 回调

**问题**：用户因网络断开、强退或心跳超时触发 `on_close` 时，直接调用 `room->remove_user(uid)`（`Room` 的成员方法），绕过了 `RoomManager::leave_room()` 中的空房间检测逻辑，导致最后一个用户断线后房间对象永远留在内存中。

主动发送 `LEAVE_ROOM` 消息的路径不受影响（走 `RoomManager::leave_room()`，正确）。

**修改前**：
```cpp
auto rooms = server->room_manager_.get_all_rooms();
for (auto* room : rooms) {
    room->remove_user(uid);  // 绕过空房间检测
}
```

**修改后**：
```cpp
std::vector<std::string> room_ids;
for (auto* room : server->room_manager_.get_all_rooms()) {
    if (room->has_user(uid)) room_ids.push_back(room->room_id());
}
for (const auto& rid : room_ids) {
    server->room_manager_.leave_room(rid, uid);  // 正确路径，空房间自动销毁
}
```

**原理**：先收集 room_id 列表再逐一调用 `leave_room`，避免在迭代过程中 `leave_room` 删除 room 导致悬空指针。

---

## v0.1.2 — 2026-04-18

**变更类型**：部署架构修正 + 服务器全面重命名

### 背景

部署过程中发现服务器实际架构与 deploy.sh 预设不符，同步完成服务器端 S1 → Tonel 品牌重命名。

### 1. `deploy.sh` 再次更新

| 问题 | 修复 |
|------|------|
| `REMOTE_DIR` 指向 `~/Tonel`，服务器实际路径为 `~/S1-BandRehearsal` | 修正为 `~/S1-BandRehearsal`（后随重命名改为 `~/Tonel`） |
| 服务进程实际由 pm2 管理，nohup 方式无效 | 改为 `pm2 restart tonel-*` |
| 构建产物需复制到 `/opt/tonel-server/bin/` 才能生效 | 添加 `cp` 步骤 |
| `npm install --omit=dev` 导致 `tsc` 缺失（devDep），Web 构建失败 | 改为完整 `npm install` |
| `deploy.sh` 被 `.gitignore` 排除，无法版本管理 | 密码删除后从 `.gitignore` 移除，正式纳入版本控制 |

**新的远程执行流程**：
```
git pull → cmake build → cp binaries to /opt/tonel-server/bin/
→ npm install + npm run build → cp dist/ to /var/www/tonel-web/
→ pm2 restart tonel-signaling tonel-mixer tonel-ws-proxy tonel-mixer-proxy
→ pm2 save
```

### 2. 服务器 S1 → Tonel 全面重命名

| 位置 | 旧名称 | 新名称 |
|------|-------|-------|
| 源码目录 | `~/S1-BandRehearsal` | `~/Tonel` |
| 服务运行目录 | `/opt/s1-server/` | `/opt/tonel-server/` |
| 启动脚本内路径 | `cd /opt/s1-server` | `cd /opt/tonel-server` |
| pm2 进程 | `s1-signaling` | `tonel-signaling` |
| pm2 进程 | `s1-mixer` | `tonel-mixer` |
| pm2 进程 | `s1-ws-proxy` | `tonel-ws-proxy` |
| pm2 进程 | `s1-mixer-proxy` | `tonel-mixer-proxy` |
| Web 静态目录 | `/var/www/s1-web` | `/var/www/tonel-web` |
| nginx `root` 指令 | `/var/www/s1-web` | `/var/www/tonel-web` |

所有 pm2 进程重新注册后执行 `pm2 save`，确保服务器重启后自动恢复。

---

## v0.1.1 — 2026-04-18

**变更类型**：安全修复 + Bug 修复

### 本次变更概述

本次修复来源于 [OPTIMIZATION.md](./OPTIMIZATION.md) 中标注的高优先级问题，共涉及 5 个文件，修复 6 处缺陷。所有修改均为保守式最小改动，不影响现有功能和协议兼容性。

---

## 1. `server/src/signaling_server.cpp`

### 修复：send_response 内存泄漏

**问题**：`uv_write` 若同步返回错误（如 `UV_EBADF`、连接已关闭等），其回调不会被调用，导致堆上的 `std::string*` 和 `uv_write_t*` 永久泄漏。长期运行的服务器会逐渐耗尽内存。

**修改前（line 185–195）**：
```cpp
void SignalingServer::send_response(uv_stream_t* client, const std::string& json_msg) {
    if (!client) return;
    std::string* msg_heap = new std::string(json_msg + "\n");
    uv_buf_t buf = uv_buf_init(const_cast<char*>(msg_heap->c_str()), msg_heap->size());
    uv_write_t* req = new uv_write_t;
    req->data = msg_heap;
    uv_write(req, client, &buf, 1, [](uv_write_t* req, int) {
        delete static_cast<std::string*>(req->data);
        delete req;
    });
}
```

**修改后**：
```cpp
void SignalingServer::send_response(uv_stream_t* client, const std::string& json_msg) {
    if (!client) return;
    std::string* msg_heap = new std::string(json_msg + "\n");
    uv_buf_t buf = uv_buf_init(const_cast<char*>(msg_heap->c_str()), msg_heap->size());
    uv_write_t* req = new uv_write_t;
    req->data = msg_heap;
    int r = uv_write(req, client, &buf, 1, [](uv_write_t* req, int) {
        delete static_cast<std::string*>(req->data);
        delete req;
    });
    if (r < 0) {
        delete msg_heap;
        delete req;
    }
}
```

**原理**：`uv_write` 返回非零值时回调不触发，需在调用点手动释放。返回零时生命周期由回调接管，不变。

---

## 2. `server/src/mixer_server.cpp`

### 修复 A：send_tcp_response 内存泄漏

与 `signaling_server.cpp` 中同一模式，`send_tcp_response` 静态函数存在相同问题。

**修改位置**：`line 179–189`  
**修复方式**：同上，检查 `uv_write` 返回值，失败时释放 `heap` 和 `req`。

---

### 修复 B：broadcast_mixed_audio UDP 发送内存泄漏

**问题**：`uv_udp_send` 同步失败时，堆上的 `std::vector<uint8_t>*` 和 `uv_udp_send_t*` 不会被释放。在网络异常或目标地址不可达时触发。

**修改位置**：`line 604–616`

**修改前**：
```cpp
req->data = heap_buf;
uv_udp_send(req, &udp_server_, &uvbuf, 1,
    reinterpret_cast<const struct sockaddr*>(&addr),
    [](uv_udp_send_t* req, int) {
        delete static_cast<std::vector<uint8_t>*>(req->data);
        delete req;
    });
```

**修改后**：
```cpp
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
```

---

## 3. `server/src/user.cpp`

### 修复：超时检查导致潜在的 double-close

**问题**：`check_timeouts()` 收集超时用户后，调用 `on_user_remove_`（触发 `uv_close`），但并未立即将用户从 `users_` 中移除。若下一次 30 秒定时器触发时用户仍未被异步的 `on_close` 回调清理（极端情况），同一个 `uv_tcp_t*` 会被 `uv_close` 调用两次，引发未定义行为或崩溃。

**修改位置**：`line 53–61`

**修改前**：
```cpp
for (const auto& uid : to_remove) {
    auto it = users_.find(uid);
    if (it != users_.end()) {
        uv_tcp_t* client = it->second->client;
        if (client && on_user_remove_) {
            on_user_remove_(uid, client);  // triggers on_close which removes from users_
        }
    }
}
```

**修改后**：
```cpp
for (const auto& uid : to_remove) {
    auto it = users_.find(uid);
    if (it != users_.end()) {
        uv_tcp_t* client = it->second->client;
        users_.erase(it);  // erase before callback to prevent double-close on next timer tick
        if (client && on_user_remove_) {
            on_user_remove_(uid, client);
        }
    }
}
```

**原理**：`on_close` 回调是异步的（下一个事件循环 tick），先 erase 确保下一轮定时器不会重复处理同一用户。`on_close` 内部的 `remove_user` 对不存在的 key 执行 `erase` 是安全的 no-op。

---

## 4. `.env.example`

### 修复：真实服务器 IP 泄漏

**问题**：`.env.example` 提交至 git 仓库，其中包含真实服务器 IP `8.163.21.207`，任何能访问仓库的人都可直接知晓服务器地址。

**修改前**：
```env
SERVER_IP=8.163.21.207
SSH_USER=root
```

**修改后**：
```env
SERVER_IP=<your-server-ip>
SSH_USER=<your-ssh-user>
```

---

## 5. `deploy.sh`

### 重写：修复多处安全和逻辑缺陷

| 问题 | 修复方式 |
|------|---------|
| 明文密码 `SSH_PASSWORD="AutoClaw000"` 硬编码 | 完全删除，强制 SSH 密钥认证 |
| SSH 回退逻辑错误（`-p` 是端口参数非密码） | 删除错误回退，密钥不存在直接退出并提示 |
| `sshpass` 无条件检查（密钥路径下不需要） | 删除 sshpass 检查 |
| 强制 `git checkout main` 不询问 | 改为询问确认后再切换 |
| 三次独立 SSH 连接（效率低，远程错误不中断） | 合并为单次 SSH 连接，`bash -e` 确保远程任意步骤失败即中断 |
| 服务重启被注释掉，新版本不生效 | 改为 `pkill + nohup` 手动进程管理，启动后验证进程存活 |
| `npm install --production`（已弃用语法） | 改为 `npm install --omit=dev` |
| Web build 未复制到 nginx 目录 | 添加 `cp -r dist/* $WEB_ROOT/` |

**新的远程执行流程（单次 SSH）**：
```
git pull → build signaling_server → build mixer_server
→ npm build → cp to nginx root
→ pkill 旧进程 → nohup 启动新进程 → 验证进程存活
```

---

## 影响范围

| 文件 | 改动行数 | 影响 |
|------|---------|------|
| `server/src/signaling_server.cpp` | +4 | 修复内存泄漏，无功能变更 |
| `server/src/mixer_server.cpp` | +8 | 修复两处内存泄漏，无功能变更 |
| `server/src/user.cpp` | +1 / -1 | 修复潜在 double-close，无功能变更 |
| `.env.example` | +2 / -2 | 脱敏，不影响运行时 |
| `deploy.sh` | 重写 | 部署流程改善，不影响服务端代码 |

所有服务端修复均为**防御性修复**，不改变任何协议行为、消息格式或业务逻辑。

---

## v0.1.0 — 2026-04-18

**变更类型**：初始版本

项目代码审查完成，输出 OPTIMIZATION.md。
