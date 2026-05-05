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
        .sheet(isPresented: $presentSettings) { HomeSettingsSheet() }
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

private struct HomeSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        SheetCard(title: "设置") {
            Text("（占位 — 后续接入输入/输出设备选择、jitter / prime 调参面板）")
                .foregroundStyle(.secondary)
                .font(.callout)
        } footer: {
            HStack {
                Spacer()
                Button("好") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
    }
}

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
