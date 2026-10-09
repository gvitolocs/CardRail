import SwiftUI

struct ItemEditSheet: View {
    let item: InventoryItem
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var quantity: Int
    @State private var priceText: String
    @State private var condition: String
    @State private var saving = false

    init(item: InventoryItem) {
        self.item = item
        _quantity = State(initialValue: item.quantity)
        _priceText = State(initialValue: String(format: "%.2f", item.price).replacingOccurrences(of: ".", with: ","))
        _condition = State(initialValue: item.condition)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Quantità") {
                    Stepper(value: $quantity, in: 0...10000) {
                        Text("\(quantity)")
                    }
                }

                Section("Prezzo") {
                    HStack {
                        Text("€").foregroundStyle(Theme.muted)
                        TextField("0,00", text: $priceText)
                            .keyboardType(.decimalPad)
                    }
                }

                Section("Condizione") {
                    Picker("Condizione", selection: $condition) {
                        ForEach(Conditions.all, id: \.self) { code in
                            Text("\(code) · \(Conditions.label(code))").tag(code)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle(item.identity.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annulla") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Salva", action: save).disabled(saving)
                }
            }
        }
    }

    private func save() {
        saving = true
        var patch = ItemPatch(version: item.version)
        patch.quantity = quantity
        patch.price = parsePrice(priceText)
        patch.condition = condition
        Task {
            await model.updateItem(id: item.id, patch: patch)
            saving = false
            dismiss()
        }
    }

    private func parsePrice(_ text: String) -> Double {
        let normalized = text
            .replacingOccurrences(of: "€", with: "")
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: ".", with: "")
            .replacingOccurrences(of: ",", with: ".")
        return Double(normalized) ?? 0
    }
}
