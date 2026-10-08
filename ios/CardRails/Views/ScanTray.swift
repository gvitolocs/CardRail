import SwiftUI

/// Bottom scan tray: the session's lines plus the commit controls.
struct ScanTray: View {
    @ObservedObject var session: ScanSession
    @Binding var editing: ScanLine?
    @EnvironmentObject private var model: AppModel

    private var lines: [ScanLine] { session.lines.reversed() }
    private var isEmpty: Bool { session.lines.isEmpty }

    var body: some View {
        VStack(spacing: 10) {
            if !isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(lines) { line in
                            Button {
                                editing = line
                            } label: {
                                LineCard(line: line)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 12)
                }
                .frame(height: 96)
            } else {
                Text("Inquadra una carta per iniziare")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
                    .frame(height: 96)
            }

            Picker("Tipo", selection: intentBinding) {
                Text("Vendita").tag("sale")
                Text("Collezione").tag("collection")
            }
            .pickerStyle(.segmented)

            Button {
                Task { await model.commit() }
            } label: {
                ZStack {
                    Text("Aggiungi all'inventario (\(session.totalCards))")
                        .font(.headline)
                        .opacity(model.isCommitting ? 0 : 1)
                    if model.isCommitting {
                        ProgressView().tint(.white)
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 50)
            }
            .background(
                (isEmpty || model.isCommitting) ? Theme.accent.opacity(0.4) : Theme.accent,
                in: RoundedRectangle(cornerRadius: Theme.corner)
            )
            .foregroundStyle(Theme.text)
            .disabled(isEmpty || model.isCommitting)
        }
        .padding(12)
        .background(Theme.header.opacity(0.96))
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private var intentBinding: Binding<String> {
        Binding(get: { model.intent }, set: { model.setIntent($0) })
    }
}

private struct LineCard: View {
    let line: ScanLine

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                thumbnail
                Text(line.record.name)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                Text("×\(line.quantity)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Theme.accent, in: Capsule())
                Spacer(minLength: 0)
                Text(line.condition)
                    .font(.caption2)
                    .foregroundStyle(Theme.muted)
            }
        }
        .padding(8)
        .frame(width: 150, height: 92, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
    }

    @ViewBuilder private var thumbnail: some View {
        if let crop = line.crop {
            Image(decorative: crop, scale: 1)
                .resizable()
                .scaledToFill()
                .frame(width: 34, height: 48)
                .clipShape(RoundedRectangle(cornerRadius: 4))
        } else {
            RoundedRectangle(cornerRadius: 4)
                .fill(Theme.line)
                .frame(width: 34, height: 48)
        }
    }
}
