import SwiftUI

@main
struct CardRailsApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .task { await model.launch() }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            if model.isSignedIn {
                MainTabView()
            } else {
                LoginView()
            }
        }
        .tint(Theme.accent)
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                ToastView(message: toast) { model.toast = nil }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.toast)
    }
}

struct ToastView: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        Text(message)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Theme.card, in: Capsule())
            .overlay(Capsule().stroke(Theme.line))
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .onTapGesture(perform: dismiss)
            .task {
                try? await Task.sleep(nanoseconds: 2_800_000_000)
                dismiss()
            }
    }
}
