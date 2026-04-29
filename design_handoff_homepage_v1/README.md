# Handoff: Tonel Homepage 重设计 (V1)

## Overview

把 Tonel 主页（`Git/web/src/pages/HomePage.tsx`）重新设计为以**实时延迟 12ms** 为视觉主角的黑客/工程风格页面，同时提供 iPhone 尺寸的移动端适配。

设计方向（来自客户确认）：
- 高保真，直接出最终视觉
- 黑客／工程感（终端、技术参数前置）
- Hero 主角是**实时跳动的 12ms 延迟数字**
- 去掉原有的 4 个 feature 圆点 + 在线乐手列表，主页只留 hero + 操作 + 实时指标
- 导航栏需要新增「定价」入口；保留登录、新增「下载」「预约房间」入口

---

## About the Design Files

本包内的 HTML / JSX / CSS 文件是**设计参考**，不是直接上线的生产代码。它们是用 React + Babel standalone 写的高保真原型，目的是精确表达视觉、布局、动效、文案。

**你的任务**：在 Tonel 现有的 `Git/web` 仓库（Vite + React 18 + TypeScript）中，把这些设计还原到 `src/pages/HomePage.tsx` + `src/styles/globals.css`，同时新增一个移动端响应式分支或独立组件。

**保留现有业务接线**：
- `HomePage` 的 props（`isLoggedIn`、`userProfile`、`onCreateRoom`、`onJoinRoom`、`onClearJoinError`、`peers`、`joinError`、`createError`）
- 路由 / `App.tsx` 的页面切换逻辑
- `WechatLogin` 登录流程
- 现有 design tokens（`--bg`、`--accent`、`--font-mono` 等）已经和设计完全对齐，**直接复用**，不要新建一套

---

## Fidelity

**High-fidelity（高保真）**。颜色、字号、间距、动效都已经定稿，请按本文件中的精确数值还原。

唯一允许的偏离：
- 字体回退已经匹配现有 `--font-sans` / `--font-mono` 变量，沿用即可
- 真实数据（在线人数、活跃房间数、uptime）请接现有后端接口，原型里是占位

---

## Screens / Views

### 1) Desktop Homepage（≥ 1024px）

**入口**：访问根路径 `/`，未在房间中时显示。

**整体布局（顶到底）**：
1. 顶部 `NavBar`（56px 高，sticky，毛玻璃）
2. 状态栏（28px 高，单行 mono 文字带 5 个技术指标）
3. Hero 区（左右两栏 1:1 网格，最小高度约 600px）
4. 底部实时指标条（4 列等宽）

#### 1.1 NavBar

| 属性 | 值 |
|---|---|
| 高度 | 56px |
| 内边距 | `0 28px` |
| 背景 | `rgba(10,10,10,0.85)` + `backdrop-filter: blur(10px)` |
| 下边框 | `1px solid #1a1a1a` |
| sticky | top: 0, z-index: 100 |

**左侧**（gap 36px）：
- Brand "Tonel" — 15px / 600 / letter-spacing 0.5px / `#e8e8e8`
- 链接列表（gap 26px，每个 13px / `#888`，hover `#e8e8e8`，过渡 0.15s）：
  - `功能` → `#features`
  - `定价` → `#pricing`  ← **新增**
  - `文档` → `#docs`
  - `GitHub ↗`（外链箭头 10px / opacity 0.6）

**右侧**（gap 8px）：
- `下载` 按钮 — ghost-sm（6×14px / 13px / 透明 / `#888` / 边框 `#222`，hover `#e8e8e8` / 边框 `#333` / 背景 `#0a0a0a`）  ← **新增**
- `登录` 按钮 — primary-sm（6×14px / 13px / 背景 `#fff` / 文字 `#000`，hover `#ccc`）

#### 1.2 状态栏 `.v1-statusbar`

- 高度自然，padding `8px 28px`
- 字体 mono / 10px / `#444` / letter-spacing 1px / uppercase
- 5 段文字横排，gap 24px：
  - `● SIGNALING ONLINE`（圆点 `#22c55e`）
  - `SAMPLE 48000 HZ`
  - `BUFFER 128`
  - `CODEC OPUS 96K`
  - `BUILD 2026.04.28`（右对齐，`margin-left: auto`，颜色 `#888`）

#### 1.3 Hero 区 — 左栏 `.v1-left`

- padding `64px 28px 64px 56px`
- 右边框 `1px solid #111`
- flex column, justify-content: center

**1.3.1 Eyebrow tag**
```
● REAL-TIME · LOSSLESS · CHINA-MAINLAND
```
- mono 11px / `#4ade80` / letter-spacing 2px / uppercase
- 前置圆点 6×6 / `#22c55e` / box-shadow `0 0 8px #22c55e`
- 下间距 24px

**1.3.2 主标题 `.v1-headline`**
```
合奏的[距离]      ← [距离] 是带 line-through 的 #444
不再有距离。      ← 渐变 #fff → #888 (135deg)
```
- 64px / 700 / letter-spacing -1.5px / line-height 1.02 / `#e8e8e8`
- `.strike`：颜色 `#444`，`text-decoration: line-through`，`text-decoration-thickness: 3px`
- `.accent`：`background: linear-gradient(135deg, #fff 0%, #888 100%)`，`-webkit-background-clip: text`
- 下间距 32px

**1.3.3 副标题 `.v1-sub`**
```
Tonel 是一个为乐手而生的实时排练平台。低于人耳可感知的音频延迟，让远在千里的两位演奏者，听起来像同处一间排练房。
```
- 16px / `#888` / line-height 1.6 / max-width 460px
- 下间距 40px

**1.3.4 操作按钮行 `.v1-actions`**（flex gap 12px，align center）
- **`免费创建房间`** — primary CTA：14×22px / 14px / 600 / `#fff` / `#000` / radius 6 / hover bg `#ccc` + translateY -1px
- **`加入房间`** — ghost CTA：14×22px / 14px / 500 / 透明 / `#e8e8e8` / 边框 `#333` / hover 边框 `#555` + 背景 `#0a0a0a`
- **`预约 Pro 试用 →`** — text link：13px / `#888` / hover `#e8e8e8`，左外距 8px

**1.3.5 Bullets 行 `.v1-bullets`**（mono，gap 28px，上间距 56px）
- 11px / `#666` / letter-spacing 1px / uppercase
- 内嵌 `<b>` 用 `#e8e8e8` / 500
- 三段：
  - `14,200+ 累计排练小时`
  - `JUCE / miniaudio 双引擎`
  - `macOS · Windows · Web`

#### 1.4 Hero 区 — 右栏 `.v1-right`

- padding 32px
- 居中显示巨型数字
- **绝对定位的延迟刻度轴 `.v1-axis`**（右上 24px，垂直居中）：
  - mono 9px / `#333` / letter-spacing 1px / line-height 1.6
  - 5 行：
    - `200ms ─ 视频会议`
    - `120ms ─ 蓝牙耳机`
    - `50ms ─ 可感知`（颜色 `#facc15`）
    - `12ms ─ TONEL ◀`（颜色 `#22c55e` / 600）
    - `10ms ─ 同房间空气声`

**巨型数字 `.v1-num`**：
- 字体 mono / 700 / **360px** / line-height 0.85
- `#fff` / letter-spacing -8px / `font-variant-numeric: tabular-nums`
- `text-shadow: 0 0 80px rgba(34,197,94,0.15)`（绿色微光）
- **数字本身是动态的**：每 220ms 在 `12 ± 2` 之间跳动（mock LiveLatency 组件，生产环境用真实信令 RTT）

**单位 `.v1-unit`**：
- mono / 56px / 600 / `#22c55e` / letter-spacing -1px

**底部标签 `.v1-num-label`**：
- mono 11px / `#444` / letter-spacing 4px / uppercase
- `END-TO-END · LIVE FROM SHANGHAI ↔ BEIJING`
- 下方 1px 横线 `.v1-num-decor`，宽 240px / `#1a1a1a`

#### 1.5 背景网格 `.v1-bg-grid`

- 整个 Hero 区的绝对定位背景层
- 双向 1px 线，间距 40×40px，颜色 `rgba(255,255,255,.018)`
- `mask-image: radial-gradient(ellipse at 50% 30%, #000 0%, transparent 75%)` —— 中心可见，边缘淡出

#### 1.6 底部实时指标 `.v1-bottom`

- grid-template-columns: 1fr 1fr 1fr 1fr
- 上边框 `1px solid #111`
- 4 个 cell，每个 padding `20px 24px`，右边框 `1px solid #111`（最后一个无）
- 每个 cell：
  - `.k`：mono 10px / `#444` / letter-spacing 2px / uppercase
  - `.v`：mono 16px / `#e8e8e8` / 500（加 `.lit` 时 `#4ade80`）
- 4 项：
  - `Latency` / `<动态> ms` (lit)
  - `Active rooms` / `2,481`
  - `Musicians online` / `8,640`
  - `Uptime · 30d` / `99.97%` (lit)

---

### 2) Mobile Homepage（< 768px，目标 iPhone 390px 宽）

**整体策略**：相同的视觉 DNA（绿点、巨型数字、mono 标签、黑底 + 绿色高亮），但布局垂直堆叠。

**顺序（从上到下）**：

1. **Mobile Nav `.v1m-nav`**（sticky，14×20px padding）
   - 左：`Tonel` 16px / 600
   - 右：汉堡按钮（36×36 / 边框 `#222` / radius 8 / 三条 16×1.5px `#888` 横线）

2. **抽屉 `.v1m-drawer`**（点击汉堡展开）
   - 背景 `#050505`，下边框 `#1a1a1a`
   - 5 行链接（14×8px padding，15px / `#ccc`，行间下边框 `#111`）：`功能` `定价` `文档` `下载桌面版 ↓` `GitHub ↗`
   - 底部 `登录` 按钮（白底黑字 / 12px padding / radius 8）

3. **状态条 `.v1m-status`**（mono 9.5px / `#444`，padding `8px 20px`，下边框 `#111`）
   - `● ONLINE`（圆点 `#22c55e`）
   - `48 kHz · OPUS 96K`

4. **Hero `.v1m-hero`**（padding `28px 22px 24px`）
   - Eyebrow `REAL-TIME · LOSSLESS`（mono 10px / `#4ade80` / 前置 5×5 绿点 + 阴影）
   - **巨型数字 156px**（其余规则同桌面）+ 28px 绿色 `ms` 单位
   - 标签 `END-TO-END · 上海 ↔ 北京`（mono 9.5px / `#444` / letter-spacing 2.5px）

5. **延迟对比柱状图 `.v1m-axis`**（替代桌面端的浮动刻度轴）
   - 容器：背景 `#050505` / 边框 `#111` / radius 10 / padding 14
   - 4 行 grid `86px 1fr 36px`（标签 / 进度条 / 数值），mono 10px：
     - `视频会议` — 100% — `200`（灰）
     - `蓝牙耳机` — 60% — `120`（灰）
     - `可感知阈值` — 25% — `50`（黄 `#facc15`）
     - `Tonel ◀` — 6% — `12`（绿 `#22c55e` + 600 + 阴影 `0 0 8px #22c55e`）
   - 进度条高 4px / radius 2 / 容器 `#111` / 填充对应颜色

6. **主标题 `.v1m-headline`**（38px / 700 / letter-spacing -1px）
   - 同桌面文案，移动端字号收小，line-height 1.04

7. **副标题 `.v1m-sub`**（14px / `#888` / line-height 1.6）

8. **操作堆叠 `.v1m-actions`**（padding `4px 22px 24px`，flex column gap 10）
   - **`免费创建房间`**：100% 宽 / 16px padding / `#fff` 背景 / `#000` 文字 / radius 10 / 15px / 600
   - 二级行 `.v1m-row2`（grid 1fr 1fr gap 10）：`加入房间` 和 `预约时段`，14px padding / 透明 / 边框 `#2a2a2a` / radius 10
   - `下载桌面客户端 →` 文字链接（居中 / 13px / `#888`）

9. **实时指标 `.v1m-stats`**（grid 2×2，每 cell 16×20px padding，内外边框 `#111`）
   - 同桌面四项 + 同样的 `.lit` 高亮

10. **Footer `.v1m-foot`**（mono 9.5px / `#333` / letter-spacing 2px / uppercase）
    - `JUCE / miniaudio` ｜ `BUILD 2026.04.28`

---

## Interactions & Behavior

### 实时延迟数字（Hero 数字 + bottom cell + axis 中的 Tonel 行）
所有这些位置都消费同一个 `latencyMs` 状态。

- **数据源**：`useSignal` hook 的 PING/PONG RTT（已在仓库存在，见 `Git/web/src/hooks/useSignal.ts`）
- **显示规则**：
  - `< 50ms` → `#4ade80`（绿）
  - `50–99ms` → `#facc15`（黄）
  - `>= 100ms` → `#f87171`（红）
  - 离线时 `--`，颜色 `#444`
- **刷新节流**：UI 显示节流到 ≥ 200ms（避免数字过快闪烁）
- **占位（未连接前）**：显示 `12`，绿色

### CTA 行为
- `免费创建房间` → 调用 `onCreateRoom(generatedId)`（保留现有的 6 位随机房间号生成）
- `加入房间` → 弹出输入面板（沿用现有 `showJoinPanel` 逻辑），或直接路由到 `/join`
- `预约 Pro 试用` / `预约时段` → 路由到 `/booking`（**新功能，留 placeholder 即可，先打到 TODO 路由**）
- `下载` → 路由到 `/download`（同上）
- `定价` 导航 → 路由到 `/pricing`（同上）
- `登录` → 沿用 `WechatLogin` 流程

### 动画
- CTA hover：`transform: translateY(-1px)` + 背景过渡 0.15s
- 链接 / 按钮 hover：颜色过渡 0.15s
- 圆点脉冲（如果用到）：`@keyframes tn-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }`，1.4–1.6s ease-in-out infinite

### 移动端断点
- `< 768px` 时切到移动布局
- `< 480px` 时数字降到 132px，标题降到 32px

---

## State Management

无新增全局 state。本页保留现有 `HomePage` 的所有 useState：
- `isJoining` / `isCreating`
- `showCreatePanel` / `showJoinPanel`（如保留弹出面板交互）

新增组件级 state：
- `latencyMs: number | null` —— 来自 `useSignal()` 的 RTT，或自上层 prop 传入
- `mobileMenuOpen: boolean`（仅移动端 nav）

---

## Design Tokens

**全部已在 `Git/web/src/styles/globals.css` 中定义，直接复用，不要新增。** 关键映射：

| 用途 | Token | 值 |
|---|---|---|
| 页面背景 | `--bg` | `#000000` |
| 卡片背景 | `--bg-elevated` | `#0a0a0a` |
| 更深的卡片 | （新增 inline）| `#050505` |
| 默认边框 | `--border` | `#222222` |
| 暗边框 | （新增 inline）| `#1a1a1a` / `#111111` |
| 主文字 | `--text` | `#e8e8e8` |
| 二级文字 | `--text-muted` | `#888888` |
| 三级文字 | `--text-faint` | `#444444` |
| 强调白 | `--accent` | `#ffffff` |
| LED 绿 | — | `#22c55e`（强调 hero）/ `#4ade80`（文字标签） |
| LED 黄 | — | `#facc15` / `#eab308` |
| LED 红 | — | `#f87171` / `#ef4444` |
| 等宽字体 | — | `'SF Mono','Fira Code', ui-monospace, Menlo, monospace` |

**Spacing**：4-pt 网格，沿用现有变量。

**Radii**：6 / 8 / 10（按钮）、10 / 12（卡片）。

---

## Assets

无外部素材。所有视觉是 CSS + 文字。已有 `Git/web/src/components/MusicBackground.tsx` 的全屏背景**保留不动**。

---

## Files in This Bundle

| 文件 | 用途 |
|---|---|
| `Tonel Homepage.html` | 入口预览页（可直接在浏览器打开看到桌面 + 移动并排） |
| `v1.jsx` | `V1Desktop` / `V1Mobile` 两个组件源码（**就是要还原的目标**） |
| `v1.css` | 桌面 (`.v1-*`) + 移动 (`.v1m-*`) 全部样式 |
| `shared.jsx` | `NavBar` + `LiveLatency` 实时跳动数字组件 |
| `tonel-tokens.css` | 设计系统 token（与目标仓库的 `globals.css` 已对齐） |
| `variations.css` | 早期 4 个方向的样式，**仅供参考**，不需要还原 V2/V3/V4 |

---

## Implementation Checklist

- [ ] 在 `App.tsx` 路由表新增 `/pricing`、`/booking`、`/download` 三个 placeholder 路由（最简实现：返回一个 `<h1>Coming soon</h1>` 的页面）
- [ ] 改造 `src/App.tsx` 顶部导航：新增「定价」链接、「下载」按钮
- [ ] 改造 `src/pages/HomePage.tsx`：
  - 移除 hero 下方的 4 个 feature 圆点（`.features`）
  - 移除 `online-section` peer 列表
  - 替换为本设计的两栏 hero + bottom stats
  - 接入 `useSignal` 的实时 RTT 用于 latency 数字
- [ ] 在 `globals.css` 新增 `.v1-*` 和 `.v1m-*` 样式（或重构成 CSS module / styled-components，取决于团队风格）
- [ ] 验证移动端响应：iPhone 390 × 844、iPhone SE 375、Android 412 三档至少手测一次
- [ ] 文案保持简体中文 + mono 区域英文 / 数字（设计是双语混排的）

---

## Open Questions（请回客户）

1. 「预约房间」是新功能吗？还是只是预约 Pro 试用？设计里两者都出现了，需要明确产品意图
2. `下载` 按钮跳到哪个 release / 第三方分发？
3. 在线人数 / 活跃房间数 / uptime 这三个数字，后端有现成接口吗？没有的话先用静态值占位
4. 移动端是否需要保留「在线乐手」列表（当前设计已删除）？
