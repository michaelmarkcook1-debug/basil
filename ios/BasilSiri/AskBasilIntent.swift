import AppIntents

/// "Hey Siri, Ask Basil" — Siri collects the question by voice, Basil's brain
/// answers, Siri speaks the reply. No Shortcuts app configuration involved.
struct AskBasilIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Basil"
    static var description = IntentDescription(
        "Ask your Basil executive assistant anything — calendar, email, Slack, commitments, decisions.",
        categoryName: "Assistant"
    )
    // Runs headless: Siri handles the whole exchange without opening the app.
    static var openAppWhenRun = false

    @Parameter(title: "Question", requestValueDialog: "What do you want to ask Basil?")
    var question: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Basil \(\.$question)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let answer = try await BasilAPI.ask(question)
        return .result(dialog: IntentDialog(stringLiteral: answer))
    }
}

/// Registers the Siri phrases. iOS picks these up automatically at install —
/// they also appear in the Shortcuts app under "App Shortcuts".
struct BasilShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskBasilIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) a question",
                "Talk to \(.applicationName)",
            ],
            shortTitle: "Ask Basil",
            systemImageName: "leaf"
        )
    }
}
