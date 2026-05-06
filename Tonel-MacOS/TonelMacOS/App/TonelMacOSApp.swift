import SwiftUI

@main
struct TonelMacOSApp: App {
    @StateObject private var state = AppState()

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
