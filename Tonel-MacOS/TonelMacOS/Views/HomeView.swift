import SwiftUI

/// Home screen — mirrors layout of legacy `HomeViewController.mm`:
/// dark BG, centered "Tonel" wordmark + subtitle, two big stacked
/// rounded buttons, a settings link at the bottom. Login lives in the
/// top-right corner instead of being a separate screen.
struct HomeView: View {
    @EnvironmentObject var state: AppState
    @State private var presentJoin = false
    @State private var presentCreate = false
    @State private var presentSettings = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            // Dark backdrop, matches AppKit S1ThemeBG.
            Color(red: 0.07, green: 0.07, blue: 0.09)
                .ignoresSafeArea()

            // Centered branding + actions.
            VStack(spacing: 0) {
                Spacer()

                Text("Tonel")
                    .font(.system(size: 56, weight: .bold))
                    .foregroundStyle(.white)

                Text("实时乐队排练平台")
                    .font(.system(size: 18, weight: .light))
                    .foregroundStyle(Color(white: 0.6))
                    .padding(.top, 12)

                VStack(spacing: 16) {
                    BigButton(title: "创建房间",
                              fill: Color(red: 0.18, green: 0.18, blue: 0.22)) {
                        presentCreate = true
                    }
                    BigButton(title: "加入房间",
                              fill: Color(red: 0.12, green: 0.28, blue: 0.55)) {
                        presentJoin = true
                    }
                }
                .padding(.top, 48)

                Spacer()

                Button {
                    presentSettings = true
                } label: {
                    Text("⚙ 设置")
                        .font(.system(size: 13))
                        .foregroundStyle(Color(white: 0.5))
                }
                .buttonStyle(.borderless)
                .padding(.bottom, 24)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Top-right login chip removed — joinRoom mints an ephemeral
            // userId on the fly, so the corner login was only ever a UI
            // affordance for setting the phone label. Pulling it to rule
            // out interaction with the join flow during debug.
        }
        .sheet(isPresented: $presentJoin)   { JoinRoomSheet() }
        .sheet(isPresented: $presentCreate) { CreateRoomSheet() }
        // Home 和 Room 共用同一个 SettingsSheet (RoomView.swift)。
        // HomeSettingsSheet 是早期占位,留 dead code 作为过渡前的引用,
        // 但已不再挂载。AudioEngine 实例从 state 注入,即使没进房间
        // 也能调输出设备 / 采样率 / 硬件 buffer。
        .sheet(isPresented: $presentSettings) {
            SettingsSheet(audio: state.audio).environmentObject(state)
        }
        // v6.1.0: surface connection failures (mixer TCP refused, WSS
        // upgrade rejected, MIXER_JOIN timeout) as a modal so the user
        // can react. No auto-fallback by design — the dialog suggests
        // toggling 协议 in Settings as the manual remediation.
        .alert("连接失败",
               isPresented: Binding(
                   get: { state.lastError != nil },
                   set: { if !$0 { state.lastError = nil } }
               ),
               presenting: state.lastError) { _ in
            Button("好") { state.lastError = nil }
        } message: { err in
            Text("\(err)\n\n如果当前网络封锁直连 UDP，可在 设置 → 服务器与传输模式 切换到 WSS 兜底重试。")
        }
    }
}

// ─── Big rounded button (240×52, mirrors S1RoundedButton) ─────────────────────

private struct BigButton: View {
    let title: String
    let fill: Color
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(.white)
                .frame(width: 240, height: 52)
                .background(
                    RoundedRectangle(cornerRadius: 12)
                        .fill(fill.opacity(hovering ? 0.85 : 1.0))
                )
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

// ─── Join / Create sheets ─────────────────────────────────────────────────────

private struct JoinRoomSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var roomId  = ""
    @State private var password = ""

    var body: some View {
        SheetCard(title: "加入房间") {
            field("房间号", text: $roomId, placeholder: "输入房间号")
            secureField("房间密码", text: $password, placeholder: "无密码则留空")
        } footer: {
            HStack {
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button {
                    Task {
                        let pw = password.isEmpty ? nil : password
                        await state.joinRoom(roomId.trimmingCharacters(in: .whitespaces),
                                             password: pw)
                        if state.screen == .room { dismiss() }
                    }
                } label: {
                    Text("加入").frame(width: 80)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(roomId.trimmingCharacters(in: .whitespaces).isEmpty
                          || state.isJoining)
            }
        }
    }
}

private struct CreateRoomSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var roomId  = ""
    @State private var password = ""

    var body: some View {
        SheetCard(title: "创建房间") {
            field("新房间号", text: $roomId, placeholder: "为房间起一个 ID")
            secureField("房间密码", text: $password, placeholder: "可留空")
        } footer: {
            HStack {
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button {
                    Task {
                        let pw = password.isEmpty ? nil : password
                        await state.joinRoom(roomId.trimmingCharacters(in: .whitespaces),
                                             password: pw, create: true)
                        if state.screen == .room { dismiss() }
                    }
                } label: {
                    Text("创建").frame(width: 80)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(roomId.trimmingCharacters(in: .whitespaces).isEmpty
                          || state.isJoining)
            }
        }
    }
}

// HomeSettingsSheet 删除 — 详见上面 .sheet 的注释,共用 RoomView 的
// SettingsSheet。

// ─── Reusable sheet primitives ────────────────────────────────────────────────

private struct SheetCard<Content: View, Footer: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    @ViewBuilder var footer: () -> Footer

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(title).font(.system(size: 22, weight: .bold))
            VStack(alignment: .leading, spacing: 14) { content() }
            footer()
        }
        .padding(24)
        .frame(width: 380)
        .background(Color(red: 0.10, green: 0.10, blue: 0.12))
    }
}

@ViewBuilder
private func field(_ label: String, text: Binding<String>, placeholder: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
        Text(label).font(.caption).foregroundStyle(.secondary)
        TextField(placeholder, text: text)
            .textFieldStyle(.roundedBorder)
    }
}

@ViewBuilder
private func secureField(_ label: String, text: Binding<String>, placeholder: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
        Text(label).font(.caption).foregroundStyle(.secondary)
        SecureField(placeholder, text: text)
            .textFieldStyle(.roundedBorder)
    }
}

#Preview {
    HomeView().environmentObject(AppState()).preferredColorScheme(.dark)
}
