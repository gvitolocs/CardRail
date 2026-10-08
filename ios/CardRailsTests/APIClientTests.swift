import XCTest
@testable import CardRails

final class APIClientTests: XCTestCase {
    private let baseURL = URL(string: "https://api.test")!

    private func makeClient(
        tokens: FakeTokenStore = FakeTokenStore(),
        center: NotificationCenter = NotificationCenter()
    ) -> (APIClient, FakeTokenStore, NotificationCenter) {
        let client = APIClient(
            baseURL: baseURL,
            session: makeStubSession(),
            tokenStore: tokens,
            notificationCenter: center
        )
        return (client, tokens, center)
    }

    func testLoginStoresToken() async throws {
        TestURLProtocol.reset()
        TestURLProtocol.handler = { _ in
            (200, Data(#"{"account":{"id":"a1","email":"e@x.com","createdAt":"now"},"token":"tok-123"}"#.utf8))
        }
        let (client, tokens, _) = makeClient()
        let response = try await client.login(email: "e@x.com", password: "pw")
        XCTAssertEqual(response.token, "tok-123")
        XCTAssertEqual(tokens.token, "tok-123")
    }

    func testBearerHeaderIsSent() async throws {
        TestURLProtocol.reset()
        final class Box: @unchecked Sendable { var value: String? }
        let box = Box()
        TestURLProtocol.handler = { request in
            box.value = request.value(forHTTPHeaderField: "Authorization")
            return (200, Data(#"{"account":{"id":"a1","email":"e@x.com","createdAt":"now"}}"#.utf8))
        }
        let tokens = FakeTokenStore()
        tokens.token = "tok-123"
        let (client, _, _) = makeClient(tokens: tokens)
        _ = try await client.me()
        XCTAssertEqual(box.value, "Bearer tok-123")
    }

    func testUnauthorizedClearsTokenAndPostsNotification() async throws {
        TestURLProtocol.reset()
        TestURLProtocol.handler = { _ in (401, Data(#"{"error":"nope"}"#.utf8)) }
        let center = NotificationCenter()
        let (client, tokens, _) = makeClient(center: center)
        tokens.token = "tok-123"

        let expectation = expectation(description: "signed out")
        let observer = center.addObserver(forName: .cardRailsSignedOut, object: nil, queue: nil) { _ in
            expectation.fulfill()
        }
        defer { center.removeObserver(observer) }

        do {
            _ = try await client.me()
            XCTFail("expected failure")
        } catch {
            XCTAssertEqual(error as? APIError, .server(status: 401, message: "nope"))
        }
        await fulfillment(of: [expectation], timeout: 1)
        XCTAssertNil(tokens.token)
    }

    func testServerErrorMessageSurfaces() async throws {
        TestURLProtocol.reset()
        TestURLProtocol.handler = { _ in (400, Data(#"{"error":"bad thing"}"#.utf8)) }
        let (client, _, _) = makeClient()
        do {
            _ = try await client.inventory()
            XCTFail("expected failure")
        } catch {
            XCTAssertEqual(error as? APIError, .server(status: 400, message: "bad thing"))
        }
    }
}
