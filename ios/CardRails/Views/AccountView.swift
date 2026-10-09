import SwiftUI

struct AccountView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showStorage = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Image("Logo")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 40, height: 40)
                            .clipShape(RoundedRectangle(cornerRadius: 9))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.account?.email ?? "—")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Theme.text)
                            Text("Account Card Rails")
                                .font(.caption)
                                .foregroundStyle(Theme.muted)
                        }
                    }
                    .listRowBackground(Theme.background)

                    Button {
                        showStorage = true
                    } label: {
                        Label("Posizione di archiviazione", systemImage: "shippingbox")
                    }
                    .listRowBackground(Theme.background)
                }

                Section("Cataloghi") {
                    if let index = model.catalogIndex {
                        ForEach(index.catalogs) { entry in
                            CatalogRow(entry: entry)
                                .listRowBackground(Theme.background)
                        }
                    } else {
                        Text("Nessun catalogo")
                            .foregroundStyle(Theme.muted)
                            .listRowBackground(Theme.background)
                    }
                }

                Section {
                    Button(role: .destructive) {
                        Task { await model.logout() }
                    } label: {
                        Label("Esci", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                    .listRowBackground(Theme.background)
                }

                Section {
                    Text("Card Rails \(Format.version())")
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Theme.background)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Account")
            .toolbarBackground(Theme.header, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .sheet(isPresented: $showStorage) {
            StorageSettingsSheet().environmentObject(model)
        }
    }
}

private struct CatalogRow: View {
    let entry: CatalogEntry
    @EnvironmentObject private var model: AppModel

    @State private var downloaded: Bool?
    @State private var busy = false

    private var size: Int { entry.embeddings.bytes + entry.cards.bytes }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.id)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text)
                Text("\(entry.game) · \(entry.languages.joined(separator: "/")) · \(Format.count(entry.count)) carte")
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
                Text(Format.bytes(size))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Theme.muted)
            }
            Spacer()
            if busy {
                ProgressView()
            } else if downloaded == true {
                Button {
                    delete()
                } label: {
                    Image(systemName: "trash")
                        .foregroundStyle(Theme.accent)
                }
                .buttonStyle(.plain)
            } else if downloaded == false {
                Button {
                    download()
                } label: {
                    Image(systemName: "arrow.down.circle")
                        .foregroundStyle(Theme.accent)
                }
                .buttonStyle(.plain)
            } else {
                ProgressView()
            }
        }
        .task { await refresh() }
    }

    private func refresh() async {
        downloaded = await model.catalogDownloaded(entry)
    }

    private func download() {
        busy = true
        Task {
            _ = await model.downloadCatalog(entry)
            await refresh()
            busy = false
        }
    }

    private func delete() {
        busy = true
        Task {
            await model.deleteCatalog(entry)
            await refresh()
            busy = false
        }
    }
}
