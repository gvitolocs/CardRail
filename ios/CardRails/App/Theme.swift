import SwiftUI

/// Card Rails palette: near-black surfaces, a single red accent, condensed
/// bold titles. Mirrors the web app.
enum Theme {
    static let background = Color(hex: 0x0d0d0f)
    static let header = Color(hex: 0x111111)
    static let card = Color(hex: 0x17171a)
    static let line = Color(hex: 0x2a2a2e)
    static let accent = Color(hex: 0xee1515)
    static let text = Color.white
    static let muted = Color(hex: 0x9a9a9f)

    static let corner: CGFloat = 12
}

extension Color {
    init(hex: UInt32) {
        let r = Double((hex >> 16) & 0xff) / 255
        let g = Double((hex >> 8) & 0xff) / 255
        let b = Double(hex & 0xff) / 255
        self.init(red: r, green: g, blue: b)
    }
}

extension Font {
    /// Condensed bold display font used for titles.
    static func display(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight).width(.condensed)
    }
}

enum Format {
    private static let decimal: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "it_IT")
        formatter.numberStyle = .decimal
        formatter.groupingSeparator = "."
        formatter.usesGroupingSeparator = true
        return formatter
    }()

    private static let money: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "it_IT")
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        formatter.groupingSeparator = "."
        formatter.usesGroupingSeparator = true
        return formatter
    }()

    /// "€12,50"
    static func price(_ value: Double) -> String {
        "€" + (money.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value))
    }

    /// "26.051"
    static func count(_ value: Int) -> String {
        decimal.string(from: NSNumber(value: value)) ?? "\(value)"
    }

    /// "12,3 MB"
    static func bytes(_ value: Int) -> String {
        let units = ["B", "KB", "MB", "GB"]
        var size = Double(value)
        var index = 0
        while size >= 1024, index < units.count - 1 {
            size /= 1024
            index += 1
        }
        let rounded = size < 10 && index > 0
            ? String(format: "%.1f", size).replacingOccurrences(of: ".", with: ",")
            : String(Int(size.rounded()))
        return "\(rounded) \(units[index])"
    }

    static func version() -> String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        switch (short, build) {
        case let (short?, build?): return "\(short) (\(build))"
        case let (short?, nil): return short
        default: return "—"
        }
    }
}
