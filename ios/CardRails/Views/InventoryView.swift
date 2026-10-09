import SwiftUI

struct InventoryView: View {
    @EnvironmentObject private var model: AppModel
    @State private var query = ""
    @State private var editing: InventoryItem?
    @State private var pendingDelete: InventoryItem?

    private var items: [InventoryItem] {
        let trimmed = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !trimmed.isEmpty else { return model.items }
        return model.items.filter { item in
            item.identity.name.lowercased().contains(trimmed)
                || item.identity.setName.lowercased().contains(trimmed)
                || item.identity.number.lowercased().contains(trimmed)
                || (locationCode(item.location)?.lowercased().contains(trimmed) ?? false)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if items.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .background(Theme.background)
            .navigationTitle("Inventario")
            .toolbarBackground(Theme.header, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
        .searchable(text: $query, prompt: "Cerca per nome, set, numero o posizione")
        .sheet(item: $editing) { item in
            ItemEditSheet(item: item)
                .environmentObject(model)
        }
        .alert(
            "Eliminare questa carta?",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            presenting: pendingDelete
        ) { item in
            Button("Elimina", role: .destructive) {
                Task { await model.deleteItem(item) }
            }
            Button("Annulla", role: .cancel) {}
        } message: { item in
            Text(item.identity.name)
        }
    }

    private var list: some View {
        List {
            ForEach(items) { item in
                Button {
                    editing = item
                } label: {
                    InventoryRow(item: item)
                }
                .buttonStyle(.plain)
                .listRowBackground(Theme.background)
                .listRowSeparatorTint(Theme.line)
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        pendingDelete = item
                    } label: {
                        Label("Elimina", systemImage: "trash")
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await model.refreshInventory() }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "square.stack.3d.up")
                .font(.system(size: 44))
                .foregroundStyle(Theme.muted)
            Text("Nessuna carta. Scansiona la prima!")
                .font(.display(20))
                .foregroundStyle(Theme.text)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
    }

    private func locationCode(_ location: InventoryLocation?) -> String? {
        guard let location, let box = location.box, let row = location.row else { return nil }
        let position = location.position.map(String.init) ?? ""
        return "B\(box)-R\(row)-\(position)"
    }
}

private struct InventoryRow: View {
    let item: InventoryItem

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AsyncImage(url: URL(string: item.art)) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                RoundedRectangle(cornerRadius: 6).fill(Theme.card)
            }
            .frame(width: 52, height: 72)
            .clipShape(RoundedRectangle(cornerRadius: 6))

            VStack(alignment: .leading, spacing: 5) {
                Text(item.identity.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .lineLimit(2)

                Text("\(item.identity.setName) · #\(item.identity.number)")
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)

                HStack(spacing: 5) {
                    chip(item.language)
                    chip(item.condition)
                    chip(item.printing)
                }

                HStack {
                    if let code = locationCode {
                        Text(code)
                            .font(.caption2.monospaced())
                            .foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    Text("×\(item.quantity)")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Theme.muted)
                    Text(Format.price(item.price))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.text)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var locationCode: String? {
        guard let location = item.location, let box = location.box, let row = location.row else {
            return nil
        }
        let position = location.position.map(String.init) ?? ""
        return "B\(box)-R\(row)-\(position)"
    }

    private func chip(_ text: String) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Theme.card, in: Capsule())
            .overlay(Capsule().stroke(Theme.line))
    }
}
