import SwiftUI

/// Edits the physical storage location used for the next scans.
struct StorageSettingsSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var label = ""
    @State private var stackSize = ""
    @State private var stack = ""
    @State private var startPosition = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Posizione") {
                    TextField("Scatola / etichetta", text: $label)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                }

                Section("Impilamento") {
                    TextField("Carte per pila", text: $stackSize)
                        .keyboardType(.numberPad)
                    TextField("Pila corrente", text: $stack)
                        .keyboardType(.numberPad)
                    TextField("Posizione iniziale", text: $startPosition)
                        .keyboardType(.numberPad)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Posizione")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annulla") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Salva", action: save)
                        .disabled(label.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .onAppear(perform: load)
        }
    }

    private func load() {
        guard let settings = model.scanSettings else { return }
        label = settings.storageLabel
        stackSize = settings.stackSize.map(String.init) ?? ""
        stack = String(settings.stack)
        startPosition = String(settings.startPosition)
    }

    private func save() {
        saving = true
        Task {
            await model.saveStorage(
                label: label,
                stackSize: Int(stackSize),
                stack: Int(stack) ?? 1,
                startPosition: Int(startPosition) ?? 1
            )
            saving = false
            dismiss()
        }
    }
}
