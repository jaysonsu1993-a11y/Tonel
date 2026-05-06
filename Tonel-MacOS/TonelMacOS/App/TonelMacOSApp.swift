import SwiftUI

@main
struct TonelMacOSApp: App {
    @StateObject private var state = AppState()

    init() {
        // POSIX `send()` on a closed TCP socket fires SIGPIPE by default,
        // which kills the process. v6.2.0+ tears down + recreates the
        // mixer when the user changes 协议 or 服务器 in Settings, so
        // there's a real race window where an in-flight write to the
        // old socket coincides with `closeTCPSocket()`. macOS doesn't
        // have Linux's `MSG_NOSIGNAL` flag, so the per-call fix
        // requires `setsockopt(SO_NOSIGPIPE)` on every socket; ignoring
        // SIGPIPE process-wide is simpler, has the same effect, and is
        // what Network.framework / URLSession do internally anyway.
        // The send() returns -1 with errno=EPIPE instead of crashing,
        // and the existing "tcpSocket >= 0" guards skip the write
        // cleanly. See v6.3.1 CHANGELOG for the symptom (app SIGPIPE
        // on UDP→WS transport switch).
        signal(SIGPIPE, SIG_IGN)
    }

    var body: some Scene {
        WindowGroup("Tonel") {
            RootView()
                .environmentObject(state)
                .frame(minWidth: 900, minHeight: 600)
                .preferredColorScheme(.dark)
        }
        .windowStyle(.hiddenTitleBar)
    }
}

/// v6.2.0: there's only one screen now — the room. App boots into it
/// via `AppState.bootstrap()` which auto-creates / re-joins a room
/// before the UI ever renders an empty state. Connection failures
/// surface as the modal alert here.
struct RootView: View {
    @EnvironmentObject var state: AppState
    var body: some View {
        RoomView()
            .alert("连接失败",
                   isPresented: Binding(
                       get: { state.lastError != nil },
                       set: { if !$0 { state.lastError = nil } }
                   ),
                   presenting: state.lastError) { _ in
                Button("好") { state.lastError = nil }
            } message: { err in
                Text("\(err)\n\n如果当前网络封锁直连 UDP，可在 设置 → 服务器与传输模式 切换到 WS 兜底重试。")
            }
    }
}
