// Tonel — shared bits used by all 4 homepage variations
// Sticky nav with new "定价" link + login + 下载 + GitHub external

const TONEL_NAV_HEIGHT = 56;

function NavBar({ variant = "default", onLogin, onDownload }) {
  return (
    <nav className="tn-nav">
      <div className="tn-nav-left">
        <a href="#" className="tn-brand">Tonel</a>
        <ul className="tn-nav-links">
          <li><a href="#features">功能</a></li>
          <li><a href="#pricing">定价</a></li>
          <li><a href="#docs">文档</a></li>
          <li><a href="#" className="tn-ext">GitHub <span className="tn-ext-arrow">↗</span></a></li>
        </ul>
      </div>
      <div className="tn-nav-right">
        <button className="tn-btn tn-btn-ghost-sm" onClick={onDownload}>下载</button>
        <button className="tn-btn tn-btn-primary-sm" onClick={onLogin}>登录</button>
      </div>
    </nav>
  );
}

// Animated audio meter — used in multiple variations.
// Renders a row of vertical LED bars. `bars` count, `seed` for variety.
function LiveMeter({ bars = 24, height = 120, width = 6, gap = 3, intensity = 1, paused = false }) {
  const [levels, setLevels] = React.useState(() => Array(bars).fill(0).map(() => Math.random() * 0.4));
  React.useEffect(() => {
    if (paused) return;
    let raf;
    const tick = () => {
      setLevels(prev => prev.map((v, i) => {
        // Per-bar musical-ish wandering
        const t = Date.now() / 1000;
        const base = 0.35 + 0.25 * Math.sin(t * 1.7 + i * 0.45) + 0.15 * Math.sin(t * 4.3 + i * 0.9);
        const jitter = (Math.random() - 0.5) * 0.18;
        return Math.max(0.03, Math.min(0.99, (base + jitter) * intensity));
      }));
      raf = requestAnimationFrame(() => setTimeout(tick, 60));
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [paused, intensity, bars]);

  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap, height }}>
      {levels.map((v, i) => (
        <div key={i} style={{
          width, height: "100%",
          background: "rgba(40,40,40,.5)", borderRadius: 2,
          display: "flex", flexDirection: "column", justifyContent: "flex-end", overflow: "hidden",
        }}>
          <div style={{
            width: "100%", height: `${v * 100}%`,
            background: "linear-gradient(to top, #22c55e 0%, #22c55e 55%, #eab308 78%, #ef4444 100%)",
            transition: "height .08s linear",
          }} />
        </div>
      ))}
    </div>
  );
}

// Live-counting latency number
function LiveLatency({ baseMs = 12, jitter = 3, paused = false, big = false }) {
  const [ms, setMs] = React.useState(baseMs);
  React.useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      setMs(baseMs + Math.round((Math.random() - 0.5) * jitter * 2));
    }, 220);
    return () => clearInterval(id);
  }, [baseMs, jitter, paused]);
  const tone = ms < 50 ? "#4ade80" : ms < 100 ? "#facc15" : "#f87171";
  return <span style={{ color: tone, fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-mono)" }}>{ms}</span>;
}

// Mini channel strip for hero illustrations — non-interactive eye-candy
function MiniStrip({ name, idx = 0 }) {
  const [lvl, setLvl] = React.useState(0.5);
  React.useEffect(() => {
    let raf;
    const t = () => {
      const time = Date.now() / 1000;
      setLvl(0.4 + 0.3 * Math.sin(time * 1.6 + idx * 0.7) + 0.15 * Math.sin(time * 4.1 + idx));
      raf = requestAnimationFrame(t);
    };
    t();
    return () => cancelAnimationFrame(raf);
  }, [idx]);
  const pct = Math.max(0.05, Math.min(0.98, lvl)) * 100;
  return (
    <div className="mini-strip">
      <div className="mini-strip-name">{name}</div>
      <div className="mini-strip-meter">
        <div className="mini-strip-fill" style={{ height: `${pct}%` }} />
      </div>
      <div className="mini-strip-fader">
        <div className="mini-strip-fader-thumb" style={{ bottom: `${20 + idx * 8 % 60}%` }} />
      </div>
      <div className="mini-strip-btns">
        <span className="mini-mute">M</span>
        <span className="mini-solo">S</span>
      </div>
    </div>
  );
}

Object.assign(window, { NavBar, LiveMeter, LiveLatency, MiniStrip, TONEL_NAV_HEIGHT });
