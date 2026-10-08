import CoreGraphics
import UIKit
import XCTest
@testable import CardRails

@MainActor
final class AppModelTests: XCTestCase {
    private let baseURL = URL(string: "https://api.test")!

    private let card = CardRecord(
        id: "p1",
        name: "Pikachu",
        number: "58",
        set: "Base",
        imageURL: URL(string: "https://img/p1.png")
    )

    private let photoJSON = Data(#"{"id":"ph1","sha256":"abc","bytes":10,"url":"https://img/ph1.jpg"}"#.utf8)

    private let itemJSON = """
    {
      "id": "item-1",
      "identity": {"game":"pokemon","name":"Pikachu","setName":"Base","number":"58",
        "publicId":"p1","cardtraderBlueprintId":""},
      "art": "https://img/p1.png",
      "language": "EN", "condition": "NM", "printing": "Standard",
      "firstEdition": false, "signed": false, "altered": false,
      "purpose": "sale", "quantity": 1, "price": 0, "currency": "EUR",
      "source": "scan", "location": null, "scanPhoto": null,
      "version": 1, "createdAt": null, "updatedAt": null
    }
    """

    private var commitJSON: Data {
        Data(#"{"items":[\#(itemJSON)],"revision":1}"#.utf8)
    }

    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var keys: [String] = []
        private var photos = 0

        func recordPhoto() {
            lock.lock(); photos += 1; lock.unlock()
        }

        func recordScan(_ key: String?) {
            lock.lock(); keys.append(key ?? ""); lock.unlock()
        }

        var scanKeys: [String] {
            lock.lock(); defer { lock.unlock() }; return keys
        }

        var photoCount: Int {
            lock.lock(); defer { lock.unlock() }; return photos
        }
    }

    private func makeModel(tokens: FakeTokenStore = FakeTokenStore()) -> AppModel {
        let client = APIClient(
            baseURL: baseURL,
            session: makeStubSession(),
            tokenStore: tokens,
            notificationCenter: NotificationCenter()
        )
        let model = AppModel(
            api: client,
            tokenStore: tokens,
            persistence: makeTempPersistence(),
            defaults: makeInstalledDefaults()
        )
        model.isSignedIn = true
        model.scanSettings = .default
        model.intent = "sale"
        return model
    }

    private func addLine(to model: AppModel) {
        model.scanSession.add(
            record: card,
            score: 0.9,
            crop: makeCrop(),
            settings: .default
        )
    }

    private func makeCrop() -> CGImage {
        let context = CGContext(
            data: nil,
            width: 8,
            height: 8,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.setFillColor(UIColor.red.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        return context.makeImage()!
    }

    func testCommitUploadsPhotosThenPostsScansWithSameKeyOnRetry() async throws {
        TestURLProtocol.reset()
        let photo = photoJSON
        let success = commitJSON
        let recorder = Recorder()
        TestURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/v1/photos") {
                recorder.recordPhoto()
                return (200, photo)
            }
            if path.hasSuffix("/v1/inventory/scans") {
                let body = request.bodyData ?? Data()
                let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
                recorder.recordScan(object?["idempotencyKey"] as? String)
                if recorder.scanKeys.count == 1 {
                    return (500, Data(#"{"error":"server down"}"#.utf8))
                }
                return (200, success)
            }
            return (404, Data())
        }

        let model = makeModel()
        addLine(to: model)

        await model.commit()
        XCTAssertFalse(model.scanSession.lines.isEmpty, "failure keeps the lines")

        await model.commit()
        let keys = recorder.scanKeys
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(keys[0], keys[1], "retry reuses the idempotency key")
        XCTAssertFalse(keys[0].isEmpty)

        XCTAssertEqual(recorder.photoCount, 2, "a photo is uploaded per commit attempt")
        XCTAssertTrue(model.scanSession.lines.isEmpty, "success clears the session")
        XCTAssertEqual(model.items.count, 1)
        XCTAssertEqual(model.items.first?.id, "item-1")
    }

    func testLocationErrorAsksForStorageAndKeepsLines() async throws {
        TestURLProtocol.reset()
        let photo = photoJSON
        TestURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/v1/photos") { return (200, photo) }
            if path.hasSuffix("/v1/inventory/scans") {
                return (400, Data(#"{"error":"location not configured"}"#.utf8))
            }
            return (404, Data())
        }

        let model = makeModel()
        addLine(to: model)
        await model.commit()

        XCTAssertTrue(model.needsStorageSetup)
        XCTAssertFalse(model.scanSession.lines.isEmpty)
        XCTAssertTrue(model.items.isEmpty)
    }
}

extension URLRequest {
    /// URLSession may move a directly-set body into `httpBodyStream`.
    var bodyData: Data? {
        if let httpBody { return httpBody }
        guard let stream = httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
