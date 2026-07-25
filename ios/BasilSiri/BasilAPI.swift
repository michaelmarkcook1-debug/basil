import Foundation

enum BasilAPIError: LocalizedError {
    case notConfigured
    case badURL
    case server(Int, String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Open the Basil app and save your server URL and Siri token first."
        case .badURL:
            return "The Basil server URL looks invalid — check it in the Basil app."
        case .server(let code, let body):
            return "Basil returned \(code): \(body)"
        }
    }
}

/// The single network call: POST /api/stig/siri with { question, token }.
/// Same contract as the Shortcuts recipe, so server-side behaviour (rate
/// limits, chat-history receipts, spoken-text formatting) is identical.
enum BasilAPI {
    static func ask(_ question: String) async throws -> String {
        let base = UserDefaults.standard.string(forKey: "basilServerURL") ?? "https://basil-app.vercel.app"
        guard let token = KeychainHelper.read(key: "basilSiriToken"), !token.isEmpty else {
            throw BasilAPIError.notConfigured
        }
        guard let url = URL(string: base.trimmingCharacters(in: .whitespacesAndNewlines))?
            .appending(path: "/api/stig/siri") else {
            throw BasilAPIError.badURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 90 // tool-loop answers can take a while
        request.httpBody = try JSONEncoder().encode(["question": question, "token": token])

        let (data, response) = try await URLSession.shared.data(for: request)
        let body = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw BasilAPIError.server(code, String(body.prefix(140)))
        }
        return body.isEmpty ? "Done." : body
    }
}
