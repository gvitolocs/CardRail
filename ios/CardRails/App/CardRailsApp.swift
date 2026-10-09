import SwiftUI

@main
struct CardRailsApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .task { await model.launch() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.becameActive() } }
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
        .overlay(alignment: .top) {
            if model.isSignedIn && model.isOffline {
                Text("Sei offline — le carte restano in coda")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Theme.accent, in: Capsule())
                    .padding(.top, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.isOffline)
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
