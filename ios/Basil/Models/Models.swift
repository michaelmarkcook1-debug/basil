import Foundation

// MARK: - Stig Status

struct StigStatus: Decodable {
    let ok: Bool
    let name: String
    let generatedAt: String
    let model: ModelInfo?

    struct ModelInfo: Decodable {
        let providerMode: String?
        let gatewayReady: Bool?
        let openaiReady: Bool?
    }
}

// MARK: - Briefing

struct BriefingResponse: Decodable, Identifiable {
    var id: String { date ?? UUID().uuidString }
    let date: String?
    let headline: String?
    let summary: String?
    let sections: [BriefingSection]?
    let generatedAt: String?

    struct BriefingSection: Decodable, Identifiable {
        var id: String { title }
        let title: String
        let body: String
        let priority: String?
    }
}

// MARK: - Chat

struct ChatMessage: Codable, Identifiable {
    var id = UUID()
    let role: String   // "user" | "assistant"
    let content: String

    enum CodingKeys: String, CodingKey {
        case role, content
    }
}

struct StigAskRequest: Encodable {
    let question: String
    let history: [ChatMessage]
}

struct StigAskResponse: Decodable {
    let answer: String
    let sources: [String]?
    let confidence: String?
}

// MARK: - Events

struct BasilEvent: Decodable, Identifiable {
    let id: String
    let type: String?
    let title: String
    let body: String?
    let source: String?
    let from: String?
    let createdAt: String?
    let tags: [String]?
    let priority: String?
}

// MARK: - Actions

struct BasilAction: Decodable, Identifiable {
    let id: String
    let title: String
    let description: String?
    let status: String?
    let priority: String?
    let dueDate: String?
    let project: String?
    let createdAt: String?
}

// MARK: - Readiness

struct ReadinessReport: Decodable {
    let checks: [ReadinessCheck]
    let blockers: [ReadinessCheck]
    let score: Int

    struct ReadinessCheck: Decodable, Identifiable {
        var id: String { checkId }
        let checkId: String
        let label: String
        let ok: Bool
        let severity: String
        let detail: String
        let action: String

        enum CodingKeys: String, CodingKey {
            case checkId = "id"
            case label, ok, severity, detail, action
        }
    }
}
