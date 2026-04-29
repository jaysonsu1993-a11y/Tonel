// V1 Desktop — 12ms 巨型数字作为主角
function V1Desktop() {
  return (
    <div className="v1">
      <div className="v1-bg-grid" />
      <div className="v1-statusbar">
        <span><span className="dot">●</span> SIGNALING ONLINE</span>
        <span>SAMPLE 48000 HZ</span>
        <span>BUFFER 128</span>
        <span>CODEC OPUS 96K</span>
        <span style={{ marginLeft: "auto", color: "#888" }}>BUILD 2026.04.28</span>
      </div>

      <div className="v1-stage">
        <div className="v1-left">
          <div className="v1-tag">REAL-TIME · LOSSLESS · CHINA-MAINLAND</div>
          <h1 className="v1-headline">
            合奏的<span className="strike">距离</span><br />
            <span className="accent">不再有距离。</span>
          </h1>
          <p className="v1-sub">
            Tonel 是一个为乐手而生的实时排练平台。低于人耳可感知的音频延迟，让远在千里的两位演奏者，听起来像同处一间排练房。
          </p>
          <div className="v1-actions">
            <button className="v1-cta">免费创建房间</button>
            <button className="v1-cta-ghost">加入房间</button>
            <a className="v1-link">预约 Pro 试用 →</a>
          </div>
          <div className="v1-bullets">
            <span><b>14,200+</b> 累计排练小时</span>
            <span><b>JUCE / miniaudio</b> 双引擎</span>
            <span><b>macOS · Windows · Web</b></span>
          </div>
        </div>

        <div className="v1-right">
          <div className="v1-axis">
            <div>200ms ─ 视频会议</div>
            <div>120ms ─ 蓝牙耳机</div>
            <div style={{ color: "#facc15" }}>50ms ─ 可感知</div>
            <div className="here">12ms ─ TONEL ◀</div>
            <div>10ms ─ 同房间空气声</div>
          </div>
          <div className="v1-num-wrap">
            <div className="v1-num">
              <LiveLatency baseMs={12} jitter={2} /><span className="v1-unit">ms</span>
            </div>
            <div className="v1-num-label">END-TO-END · LIVE FROM SHANGHAI ↔ BEIJING</div>
            <div className="v1-num-decor" />
          </div>
        </div>
      </div>

      <div className="v1-bottom">
        <div className="v1-cell">
          <span className="k">Latency</span>
          <span className="v lit"><LiveLatency baseMs={12} jitter={2} /> ms</span>
        </div>
        <div className="v1-cell">
          <span className="k">Active rooms</span>
          <span className="v">2,481</span>
        </div>
        <div className="v1-cell">
          <span className="k">Musicians online</span>
          <span className="v">8,640</span>
        </div>
        <div className="v1-cell">
          <span className="k">Uptime · 30d</span>
          <span className="v lit">99.97%</span>
        </div>
      </div>
    </div>
  );
}

// V1 Mobile — same DNA, redesigned for ~390px portrait
function V1Mobile() {
  const [menu, setMenu] = React.useState(false);
  return (
    <div className="v1m">
      {/* Mobile nav */}
      <header className="v1m-nav">
        <span className="v1m-brand">Tonel</span>
        <button className="v1m-menu" onClick={() => setMenu(m => !m)} aria-label="menu">
          <span /><span /><span />
        </button>
      </header>
      {menu && (
        <div className="v1m-drawer">
          <a>功能</a><a>定价</a><a>文档</a>
          <a>下载桌面版 ↓</a><a>GitHub ↗</a>
          <button className="v1m-drawer-login">登录</button>
        </div>
      )}

      {/* Status strip */}
      <div className="v1m-status">
        <span><span className="dot">●</span> ONLINE</span>
        <span>48 kHz · OPUS 96K</span>
      </div>

      {/* Hero */}
      <div className="v1m-hero">
        <div className="v1m-tag">REAL-TIME · LOSSLESS</div>
        <div className="v1m-num-wrap">
          <div className="v1m-num">
            <LiveLatency baseMs={12} jitter={2} /><span className="v1m-unit">ms</span>
          </div>
          <div className="v1m-num-label">END-TO-END · 上海 ↔ 北京</div>
        </div>

        {/* Compact comparison axis */}
        <div className="v1m-axis">
          <div className="row"><span className="lbl">视频会议</span><div className="bar"><span style={{ width: "100%" }} /></div><span className="num">200</span></div>
          <div className="row"><span className="lbl">蓝牙耳机</span><div className="bar"><span style={{ width: "60%" }} /></div><span className="num">120</span></div>
          <div className="row warn"><span className="lbl">可感知阈值</span><div className="bar"><span style={{ width: "25%" }} /></div><span className="num">50</span></div>
          <div className="row good"><span className="lbl">Tonel ◀</span><div className="bar"><span style={{ width: "6%" }} /></div><span className="num">12</span></div>
        </div>

        <h1 className="v1m-headline">
          合奏的<span className="strike">距离</span>
          <br /><span className="accent">不再有距离。</span>
        </h1>
        <p className="v1m-sub">
          为乐手而生的实时排练平台。低于人耳可感知的延迟，让千里之外的两位演奏者，像同处一间排练房。
        </p>
      </div>

      {/* Sticky-feeling action stack */}
      <div className="v1m-actions">
        <button className="v1m-cta">免费创建房间</button>
        <div className="v1m-row2">
          <button className="v1m-ghost">加入房间</button>
          <button className="v1m-ghost">预约时段</button>
        </div>
        <a className="v1m-link">下载桌面客户端 →</a>
      </div>

      {/* Live stats */}
      <div className="v1m-stats">
        <div className="cell">
          <span className="k">LATENCY</span>
          <span className="v lit"><LiveLatency baseMs={12} jitter={2} /> ms</span>
        </div>
        <div className="cell">
          <span className="k">ACTIVE ROOMS</span>
          <span className="v">2,481</span>
        </div>
        <div className="cell">
          <span className="k">ONLINE</span>
          <span className="v">8,640</span>
        </div>
        <div className="cell">
          <span className="k">UPTIME 30D</span>
          <span className="v lit">99.97%</span>
        </div>
      </div>

      {/* Footer meta */}
      <div className="v1m-foot">
        <span>JUCE / miniaudio</span>
        <span>BUILD 2026.04.28</span>
      </div>
    </div>
  );
}

Object.assign(window, { V1Desktop, V1Mobile });
