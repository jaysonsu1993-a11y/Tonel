import SwiftUI

/// Channel strip — visual parity with web `ChannelStrip.tsx`:
/// avatar/title row, dB scale labels, vertical LED meter, vertical fader,
/// dB readout, M (mute) + S (solo) buttons. Scroll-wheel adjusts the fader
/// (Shift = fine).
///
/// Volume is the canonical 0–100 model used by the web client; converted
/// to linear gain on send (`v/100`).
struct ChannelStripView: View {
    let title: String
    var subtitle: String? = nil
    let level: Float        // 0…1 input level, post-fader is rendered
    var isSelf: Bool = false
    @Binding var volume: Double      // 0–100
    @Binding var muted: Bool
    @Binding var soloed: Bool
    var showSolo: Bool = true
    var showMute: Bool = true
    var onVolumeChange: ((Double) -> Void)? = nil
    var onMuteChange:   ((Bool)   -> Void)? = nil
    var onSoloChange:   ((Bool)   -> Void)? = nil

    private static let dbMarks: [Int] = [0, -6, -12, -18, -24, -36, -48]
    private let meterHeight: CGFloat = 180

    private var displayLevel: Float {
        muted ? 0 : level * Float(volume / 100.0)
    }

    private var dbReadout: String {
        if volume <= 0 { return "-inf dB" }
        let db = 20.0 * log10(volume / 100.0)
        return "\(Int(db.rounded())) dB"
    }

    var body: some View {
        VStack(spacing: 8) {
            // Header
            VStack(spacing: 2) {
                Text(title)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: 96)
                    .foregroundStyle(isSelf ? Color.green : Color(white: 0.85))
                if let s = subtitle {
                    Text(s)
                        .font(.system(size: 10))
                        .foregroundStyle(Color(white: 0.5))
                        .lineLimit(1)
                }
            }
            .frame(height: 32)

            // Meter + fader area
            HStack(spacing: 6) {
                dbScale
                    .frame(width: 18, height: meterHeight)
                LedMeterView(level: displayLevel)
                    .frame(width: 10, height: meterHeight)
                fader
                    .frame(width: 30, height: meterHeight)
            }

            // dB readout
            Text(dbReadout)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Color(white: 0.7))

            // M / S buttons
            HStack(spacing: 4) {
                if showMute {
                    smallButton(label: "M",
                                active: muted,
                                activeColor: .red) {
                        muted.toggle()
                        onMuteChange?(muted)
                    }
                }
                if showSolo {
                    smallButton(label: "S",
                                active: soloed,
                                activeColor: .yellow) {
                        soloed.toggle()
                        onSoloChange?(soloed)
                    }
                }
            }
            .frame(height: 22)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 8)
        .frame(width: 96)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(red: 0.10, green: 0.10, blue: 0.12))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(isSelf ? Color.green.opacity(0.5)
                               : Color.white.opacity(0.06),
                        lineWidth: 1)
        )
    }

    // ── dB scale labels (right-aligned numbers next to meter) ─────────────
    private var dbScale: some View {
        GeometryReader { geo in
            ZStack(alignment: .topTrailing) {
                ForEach(Self.dbMarks, id: \.self) { db in
                    let y = (CGFloat(0 - db) / 48.0) * geo.size.height
                    Text("\(db)")
                        .font(.system(size: 8, design: .monospaced))
                        .foregroundStyle(db >= -3 ? Color.red.opacity(0.85)
                                                  : Color(white: 0.5))
                        .frame(width: 18, alignment: .trailing)
                        .offset(y: max(0, y - 4))
                }
            }
        }
    }

    // ── Vertical fader with scroll-wheel support ───────────────────────────
    private var fader: some View {
        VerticalFader(value: $volume,
                      onCommit: { v in onVolumeChange?(v) })
    }

    private func smallButton(label: String,
                             active: Bool,
                             activeColor: Color,
                             action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(active ? .white : Color(white: 0.7))
                .frame(width: 24, height: 22)
                .background(
                    RoundedRectangle(cornerRadius: 3)
                        .fill(active ? activeColor : Color(white: 0.18))
                )
        }
        .buttonStyle(.plain)
    }
}

// ─── Vertical fader ───────────────────────────────────────────────────────────
//
// Custom Slider replacement so we can:
//   1. orient vertically with the value increasing upward
//   2. style the cap as a console-style fader handle
//   3. capture scroll-wheel events for fine adjustment

private struct VerticalFader: NSViewRepresentable {
    @Binding var value: Double         // 0…100
    var onCommit: (Double) -> Void

    func makeNSView(context: Context) -> FaderView {
        let v = FaderView()
        v.value = value
        v.onChange = { newValue in
            value = newValue
            onCommit(newValue)
        }
        return v
    }

    func updateNSView(_ nsView: FaderView, context: Context) {
        if abs(nsView.value - value) > 0.01 { nsView.value = value }
    }
}

private final class FaderView: NSView {
    var value: Double = 100 { didSet { needsDisplay = true } }
    var onChange: ((Double) -> Void)?

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private let trackInset: CGFloat = 4
    private let capHeight:  CGFloat = 22
    private let capWidth:   CGFloat = 24

    override func draw(_ dirtyRect: NSRect) {
        let h = bounds.height
        let w = bounds.width

        // Track (groove)
        let trackRect = NSRect(x: w / 2 - 2,
                               y: trackInset,
                               width: 4,
                               height: h - 2 * trackInset)
        NSColor(calibratedWhite: 0.12, alpha: 1).setFill()
        NSBezierPath(roundedRect: trackRect, xRadius: 2, yRadius: 2).fill()

        // Tick marks every 10
        NSColor(calibratedWhite: 0.30, alpha: 1).setStroke()
        for tick in stride(from: 0, through: 100, by: 10) {
            let y = ratioToY(CGFloat(tick) / 100.0)
            let line = NSBezierPath()
            line.move(to:    NSPoint(x: w / 2 - 8, y: y))
            line.line(to:    NSPoint(x: w / 2 + 8, y: y))
            line.lineWidth = 1
            line.stroke()
        }

        // Fader cap
        let y = ratioToY(CGFloat(value) / 100.0)
        let cap = NSRect(x: (w - capWidth) / 2,
                         y: y - capHeight / 2,
                         width: capWidth,
                         height: capHeight)
        let path = NSBezierPath(roundedRect: cap, xRadius: 3, yRadius: 3)
        NSColor(calibratedRed: 0.18, green: 0.20, blue: 0.24, alpha: 1).setFill()
        path.fill()
        NSColor(calibratedWhite: 0.45, alpha: 1).setStroke()
        path.lineWidth = 1
        path.stroke()
        // Fader cap centerline
        NSColor(calibratedWhite: 0.7, alpha: 1).setStroke()
        let mid = NSBezierPath()
        mid.move(to: NSPoint(x: cap.minX + 4, y: cap.midY))
        mid.line(to: NSPoint(x: cap.maxX - 4, y: cap.midY))
        mid.lineWidth = 1
        mid.stroke()
    }

    private func ratioToY(_ r: CGFloat) -> CGFloat {
        let usable = bounds.height - 2 * trackInset - capHeight
        return trackInset + capHeight / 2 + r * usable
    }

    private func yToRatio(_ y: CGFloat) -> CGFloat {
        let usable = bounds.height - 2 * trackInset - capHeight
        let raw = (y - trackInset - capHeight / 2) / max(1, usable)
        return min(1, max(0, raw))
    }

    // Drag handling
    override func mouseDown(with event: NSEvent) { commit(at: event) }
    override func mouseDragged(with event: NSEvent) { commit(at: event) }

    private func commit(at event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let r = yToRatio(p.y)
        let v = Double(r) * 100.0
        value = v
        onChange?(v)
    }

    // Scroll-wheel adjustment: shift = fine (0.1 step per detent)
    override func scrollWheel(with event: NSEvent) {
        let fine = event.modifierFlags.contains(.shift)
        let step = fine ? 0.1 : 1.0
        // Up scroll = louder.
        let direction: Double = event.scrollingDeltaY > 0 ? 1 : -1
        let currentDb = value <= 0 ? -60 : 20.0 * log10(value / 100.0)
        let newDb = min(0, max(-60, currentDb + direction * step))
        let newVol = newDb <= -60 ? 0 : min(100, max(0, pow(10, newDb / 20) * 100))
        value = newVol
        onChange?(newVol)
    }
}

// ─── LedMeter helper extension ─────────────────────────────────────────────────
// (LedMeterView already exists in LedMeterView.swift.)
