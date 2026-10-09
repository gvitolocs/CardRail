import Foundation

/// Bounded, local diagnostic log: geometry and timings, never photos or tokens.
final class ScanDiagnostics {
    static let shared = ScanDiagnostics()
    private let queue = DispatchQueue(label: "com.cardrails.scan.diagnostics")
    private let url: URL
    private init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        url = caches.appendingPathComponent("cardrails-scan.log")
    }
    func record(_ message: String) {
        let line = "\(Date().ISO8601Format()) [scan] \(message)\n"
        queue.async { [url] in
            var data = (try? Data(contentsOf: url)) ?? Data()
            data.append(Data(line.utf8))
            if data.count > 262144 { data = Data(data.suffix(131072)) }
            try? data.write(to: url, options: .atomic)
        }
    }
}
