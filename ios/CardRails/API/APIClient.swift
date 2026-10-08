import Foundation

enum APIError: Error, Equatable {
    case server(status: Int, message: String)
    case invalidResponse
    case transport(String)
}

extension Notification.Name {
    static let cardRailsSignedOut = Notification.Name("cardRailsSignedOut")
}

/// Thin async client for the Card Rails backend. Non-2xx responses map to
/// `APIError.server` carrying the server's `{"error": "..."}` message; a 401
/// clears the stored token and posts `cardRailsSignedOut`.
final class APIClient {
    let baseURL: URL
    private let session: URLSession
    private let tokenStore: TokenStoring
    private let notificationCenter: NotificationCenter

    init(
        baseURL: URL? = nil,
        session: URLSession? = nil,
        tokenStore: TokenStoring = KeychainTokenStore(),
        notificationCenter: NotificationCenter = .default
    ) {
        self.baseURL = baseURL ?? APIClient.defaultBaseURL()
        if let session = session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.timeoutIntervalForRequest = 15
            configuration.waitsForConnectivity = false
            self.session = URLSession(configuration: configuration)
        }
        self.tokenStore = tokenStore
        self.notificationCenter = notificationCenter
    }

    static func defaultBaseURL() -> URL {
        if
            let value = Bundle.main.object(forInfoDictionaryKey: "CardRailsAPIBase") as? String,
            let url = URL(string: value)
        {
            return url
        }
        return URL(string: "https://cardrails-api.pokoin.com")!
    }

    // MARK: - Auth

    func signup(email: String, password: String) async throws -> AuthResponse {
        try await send(
            "POST",
            "v1/auth/signup",
            body: Credentials(email: email, password: password, client: "ios"),
            decode: AuthResponse.self
        )
    }

    func login(email: String, password: String) async throws -> AuthResponse {
        let response: AuthResponse = try await send(
            "POST",
            "v1/auth/login",
            body: Credentials(email: email, password: password, client: "ios"),
            decode: AuthResponse.self
        )
        tokenStore.save(response.token)
        return response
    }

    func logout() async throws {
        let _: EmptyResponse = try await send("POST", "v1/auth/logout", decode: EmptyResponse.self)
        tokenStore.clear()
    }

    func me() async throws -> Account {
        try await send("GET", "v1/auth/me", decode: Account.self)
    }

    // MARK: - Inventory

    func inventory() async throws -> InventoryResponse {
        try await send("GET", "v1/inventory", decode: InventoryResponse.self)
    }

    func updateSettings(_ update: ScanSettingsUpdate) async throws -> SettingsResponse {
        try await send("PUT", "v1/inventory/settings", body: update, decode: SettingsResponse.self)
    }

    func uploadPhoto(_ jpeg: Data) async throws -> PhotoResponse {
        try await send(
            "POST",
            "v1/photos",
            rawBody: jpeg,
            contentType: "image/jpeg",
            decode: PhotoResponse.self
        )
    }

    func commitScans(_ commit: ScanCommit) async throws -> CommitResponse {
        try await send("POST", "v1/inventory/scans", body: commit, decode: CommitResponse.self)
    }

    func patchItem(id: String, patch: ItemPatch) async throws -> ItemResponse {
        try await send("PATCH", "v1/inventory/items/\(id)", body: patch, decode: ItemResponse.self)
    }

    func deleteItem(id: String, version: Int) async throws -> OkResponse {
        try await send(
            "DELETE",
            "v1/inventory/items/\(id)",
            query: [URLQueryItem(name: "version", value: String(version))],
            decode: OkResponse.self
        )
    }

    // MARK: - Transport

    private struct Credentials: Codable {
        let email: String
        let password: String
        let client: String
    }

    private func send<Body: Encodable, T: Decodable>(
        _ method: String,
        _ path: String,
        body: Body,
        query: [URLQueryItem]? = nil,
        decode: T.Type
    ) async throws -> T {
        let data = try JSONEncoder().encode(body)
        return try await send(
            method,
            path,
            rawBody: data,
            contentType: "application/json",
            query: query,
            decode: decode
        )
    }

    private func send<T: Decodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem]? = nil,
        decode: T.Type
    ) async throws -> T {
        try await send(method, path, rawBody: nil, contentType: nil, query: query, decode: decode)
    }

    private func send<T: Decodable>(
        _ method: String,
        _ path: String,
        rawBody: Data?,
        contentType: String?,
        query: [URLQueryItem]? = nil,
        decode: T.Type
    ) async throws -> T {
        var url = baseURL.appendingPathComponent(path)
        if let query = query, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.queryItems = query
            if let composed = components.url { url = composed }
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token = tokenStore.load() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let rawBody = rawBody {
            request.httpBody = rawBody
            request.setValue(contentType ?? "application/json", forHTTPHeaderField: "Content-Type")
        } else if method == "POST" || method == "PUT" || method == "PATCH" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        if http.statusCode == 401 {
            tokenStore.clear()
            notificationCenter.post(name: .cardRailsSignedOut, object: nil)
        }

        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(APIErrorMessage.self, from: data))?.error
                ?? "Request failed."
            throw APIError.server(status: http.statusCode, message: message)
        }

        if T.self == EmptyResponse.self, data.isEmpty {
            return EmptyResponse() as! T
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
