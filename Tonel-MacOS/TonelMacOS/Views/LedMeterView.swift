import SwiftUI

/// Single-bar level meter — bit-for-bit port of web `LedMeter.tsx`:
///   • Vertical bar, dark background, rounded corners.
///   • Fill height = dB-mapped level: 0 dB → 100 %, -60 dB → 0 %.
///   • Gradient: green up to 60 %, yellow at 80 %, red at 100 %.
///   • 0.08 s linear height transition for smooth meter motion.
struct LedMeterView: View {
    var level: Float

    /// Web's `toDb`: linear → dB-scaled fraction.
    ///   0 → 0 ; clamp((20·log10(v) + 60) / 60, 0, 1)
    private static func toDb(_ v: Float) -> Float {
        guard v > 0 else { return 0 }
        let db = 20.0 * log10(v)
        return min(1, max(0, (db + 60) / 60))
    }

    var body: some View {
        let pct = CGFloat(Self.toDb(level))
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                // Dark groove background.
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color(white: 0.16, opacity: 0.5))

                // Gradient fill, anchored to bottom.
                RoundedRectangle(cornerRadius: 4)
                    .fill(LinearGradient(
                        gradient: Gradient(stops: [
                            .init(color: Color(red: 0.13, green: 0.77, blue: 0.37),
                                  location: 0.00),               // #22c55e
                            .init(color: Color(red: 0.13, green: 0.77, blue: 0.37),
                                  location: 0.60),               // #22c55e
                            .init(color: Color(red: 0.92, green: 0.70, blue: 0.03),
                                  location: 0.80),               // #eab308
                            .init(color: Color(red: 0.94, green: 0.27, blue: 0.27),
                                  location: 1.00),               // #ef4444
                        ]),
                        startPoint: .bottom, endPoint: .top))
                    .frame(height: geo.size.height * pct)
                    .animation(.linear(duration: 0.08), value: pct)
            }
        }
    }
}

#Preview {
    HStack(spacing: 12) {
        LedMeterView(level: 0.001)
        LedMeterView(level: 0.05)
        LedMeterView(level: 0.2)
        LedMeterView(level: 0.5)
        LedMeterView(level: 0.9)
        LedMeterView(level: 1.0)
    }
    .frame(width: 80, height: 200)
    .padding()
    .background(.black)
}
