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
