import SwiftUI

/// Compact corner login card. Shows a phone field + "进入" button when
/// logged out; collapses to a user chip + 退出 link once logged in.
///
/// Mirrors web `LoginPage.tsx` semantics: no real OTP, phone simply seeds
/// an ephemeral userId.
struct CornerLoginView: View {
    @EnvironmentObject var state: AppState
    @State private var phone = ""
    @FocusState private var phoneFocused: Bool

    var body: some View {
        Group {
            if state.isLoggedIn { loggedInView } else { loginForm }
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
        )
        .frame(width: 280)
    }

    private var loginForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("手机号登录").font(.caption.bold())
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                TextField("手机号", text: $phone)
                    .textFieldStyle(.roundedBorder)
                    .focused($phoneFocused)
                    .onSubmit { submit() }
                Button("进入") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(phone.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private var loggedInView: some View {
        HStack(spacing: 10) {
            Circle().fill(Color.green).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(state.phone.isEmpty ? "已登录" : state.phone)
                    .font(.caption.bold())
                Text(state.userId.suffix(8))
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("退出") { state.logout() }
                .buttonStyle(.borderless)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func submit() {
        let t = phone.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        state.login(phone: t)
    }
}

#Preview {
    CornerLoginView().environmentObject(AppState()).padding().frame(width: 400)
}
