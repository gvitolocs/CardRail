import SwiftUI

/// Bottom card shown when recognition isn't confident enough: the top three
/// candidates. Tapping one adds it; "Ignora" dismisses.
struct CandidatePicker: View {
    let matches: [Match]
    let onPick: (Match) -> Void
    let onIgnore: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Quale carta?")
                    .font(.display(18))
                    .foregroundStyle(Theme.text)
                Spacer()
                Button("Ignora", action: onIgnore)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.muted)
            }

            ForEach(Array(matches.enumerated()), id: \.offset) { _, match in
                Button {
                    onPick(match)
                } label: {
                    CandidateRow(match: match)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line))
        .padding(.horizontal, 12)
    }
}

private struct CandidateRow: View {
    let match: Match

    var body: some View {
        HStack(spacing: 12) {
            AsyncImage(url: match.record.imageURL) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                RoundedRectangle(cornerRadius: 6).fill(Theme.line)
            }
            .frame(width: 44, height: 62)
            .clipShape(RoundedRectangle(cornerRadius: 6))

            VStack(alignment: .leading, spacing: 3) {
                Text(match.record.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .lineLimit(2)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
            }
            Spacer()
            Text("\(Int((match.score * 100).rounded()))%")
                .font(.caption.monospacedDigit().weight(.bold))
                .foregroundStyle(Theme.accent)
        }
        .padding(8)
        .background(Theme.background, in: RoundedRectangle(cornerRadius: 10))
    }

    private var subtitle: String {
        let set = match.record.set ?? ""
        let number = match.record.number ?? ""
        let parts = [set, number.isEmpty ? "" : "#\(number)"].filter { !$0.isEmpty }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }
}
