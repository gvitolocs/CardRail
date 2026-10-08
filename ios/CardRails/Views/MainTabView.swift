import SwiftUI

struct MainTabView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        TabView {
            ScanView()
                .tabItem { Label("Scansiona", systemImage: "camera.viewfinder") }

            InventoryView()
                .tabItem { Label("Inventario", systemImage: "square.stack.3d.up") }
                .badge(model.items.count)

            AccountView()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
        .tint(Theme.accent)
    }
}
