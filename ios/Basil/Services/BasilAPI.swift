import Foundation

// MARK: - Configuration

struct BasilConfig {
    static let shared = BasilConfig()
    private let defaults = UserDefaults.standard

    var baseURL: String {
        get { defaults.string(forKey: "basil_base_url") ?? "https://ag-contracts.vercel.app" }
        set { defaults.set(newValue, forKey: "basil_base_url") }
    }

    var apiToken: String {
        get { KeychainService.load(key: "basil_api_token") ?? "" }
        set { KeychainService.save(key: "basil_api_token", value: newValue) }
    }

    var isConfigured: Bool { !apiToken.isEmpty }
}

// MARK: - API Errors

enum BasilAPIError: LocalizedError {
    case notConfigured
    case invalidURL
    case httpError(Int, String)
    case decodingError(Error)
    case networkError(Error)

    var errorDescription: String? {
        switch self {
        case .notConfigured:      return "API token not set. Go to Settings to configure."
        case .invalidURL:         return "Invalid server URL."
        case .httpError(let c, let m): return "Server error \(c): \(m)"
        case .decodingError(let e):    return "Response parse error: \(e.localizedDescription)"
        case .networkError(let e):     return "Network error: \(e.localizedDescription)"
        }
    }
}

// MARK: - API Client

actor BasilAPI {
    static let shared = BasilAPI()

    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest  = 60
        cfg.timeoutIntervalForResource = 120
        return URLSession(configuration: cfg)
    }()

    private func request(_ path: String, method: String = "GET", body: Encodable? = nil) throws -> URLRequest {
        let config = BasilConfig.shared
        guard config.isConfigured else { throw BasilAPIError.notConfigured }
        guard let url = URL(string: config.baseURL + path) else { throw BasilAPIError.invalidURL }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(config.apiToken)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        return req
    }

    private func fetch<T: Decodable>(_ path: String, method: String = "GET", body: Encodable? = nil) async throws -> T {
        let req = try request(path, method: method, body: body)
        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0

        guard (200..<300).contains(status) else {
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? HTTPURLResponse.localizedString(forStatusCode: status)
            throw BasilAPIError.httpError(status, msg)
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw BasilAPIError.decodingError(error)
        }
    }

    // MARK: - Endpoints

    func status() async throws -> StigStatus {
        try await fetch("/api/stig/status")
    }

    func briefing() async throws -> BriefingResponse {
        try await fetch("/api/stig/briefing", method: "POST")
    }

    func ask(_ question: String, history: [ChatMessage] = []) async throws -> StigAskResponse {
        let body = StigAskRequest(question: question, history: history)
        return try await fetch("/api/stig/ask", method: "POST", body: body)
    }

    func events(limit: Int = 30) async throws -> [BasilEvent] {
        let items: [BasilEvent] = try await fetch("/api/events?limit=\(limit)")
        return items
    }

    func actions() async throws -> [BasilAction] {
        try await fetch("/api/actions")
    }

    func readiness() async throws -> ReadinessReport {
        try await fetch("/api/readiness")
    }
}
