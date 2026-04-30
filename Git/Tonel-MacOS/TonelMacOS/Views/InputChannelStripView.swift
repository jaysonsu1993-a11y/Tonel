import SwiftUI
import CoreAudio

/// One mic input track — mirrors web `InputChannelStrip.tsx`:
/// device dropdown + remove button stacked on top of a regular ChannelStrip.
///
/// Multi-channel mic mixing on the AppKit side is currently single-channel —
/// the AVAudioEngine tap is mounted on the system default input. The dropdown
/// switches the system input device (per-channel device routing inside the
/// engine is a future job; UI layout is provided so it's a drop-in once the
/// engine grows multi-input support).
struct InputChannelStripView: View {
    let channelLabel: String      // "MIC 1" etc.
    let inputDevices: [AudioDeviceInfo]
    @Binding var selectedDeviceId: AudioDeviceID
    let canRemove: Bool
    let level: Float
    @Binding var volume: Double
    @Binding var muted: Bool
    var onDeviceChange: ((AudioDeviceID) -> Void)? = nil
    var onRemove: (() -> Void)? = nil
    var onVolumeChange: ((Double) -> Void)? = nil
    var onMuteChange:   ((Bool)   -> Void)? = nil

    @State private var soloed: Bool = false      // visual-only on inputs

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                deviceMenu
                if canRemove, onRemove != nil {
                    Button {
                        onRemove?()
                    } label: {
                        Text("×")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Color(red: 1, green: 0.85, blue: 0.85))
                            .frame(width: 18, height: 20)
                            .background(Color(red: 0.23, green: 0.06, blue: 0.06),
                                        in: RoundedRectangle(cornerRadius: 3))
                            .overlay(RoundedRectangle(cornerRadius: 3)
                                .stroke(Color(red: 0.48, green: 0.10, blue: 0.10), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(height: 22)

            ChannelStripView(
                title: channelLabel,
                subtitle: deviceLabel,
                level: level,
                isSelf: true,
                volume: $volume,
                muted: $muted,
                soloed: $soloed,
                showSolo: false,
                onVolumeChange: onVolumeChange,
                onMuteChange: onMuteChange
            )
        }
    }

    private var deviceLabel: String {
        if let d = inputDevices.first(where: { $0.id == selectedDeviceId }) {
            return d.name
        }
        return "Default"
    }

    private var deviceMenu: some View {
        Menu {
            Button("Default") { onDeviceChange?(0); selectedDeviceId = 0 }
            Divider()
            ForEach(inputDevices, id: \.id) { d in
                Button(d.name) {
                    selectedDeviceId = d.id
                    onDeviceChange?(d.id)
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(deviceLabel)
                    .font(.system(size: 11))
                    .lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: 96, alignment: .leading)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8))
            }
            .padding(.horizontal, 6).padding(.vertical, 3)
            .foregroundStyle(Color(white: 0.85))
            .background(Color(white: 0.13),
                        in: RoundedRectangle(cornerRadius: 3))
            .overlay(RoundedRectangle(cornerRadius: 3)
                .stroke(Color(white: 0.30), lineWidth: 1))
        }
        .menuStyle(.borderlessButton)
        .frame(width: 122)
    }
}
