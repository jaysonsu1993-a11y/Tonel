import SwiftUI

@main
struct TonelMacOSApp: App {
    @StateObject private var state = AppState()

    init() {
        // Touch the logger early so the file is created (and the
        // /tmp/tonel-app.log symlink is set up) before any user
        // interaction. Lets the operator `tail -f` from the moment the
        // app launches, instead of waiting for the first
        // signal/mixer/audio code path to fire.
        AppLog.log("[App] launched MARKETING_VERSION=\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "?")")
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

struct RootView: View {
    @EnvironmentObject var state: AppState
    var body: some View {
        Group {
            switch state.screen {
            case .home: HomeView()
            case .room: RoomView()
            }
        }
        .alert("出错了",
               isPresented: Binding(get: { state.lastError != nil },
                                    set: { if !$0 { state.lastError = nil } })) {
            Button("好") { state.lastError = nil }
        } message: {
            Text(state.lastError ?? "")
        }
    }
}
