import SwiftUI

@main
struct BasilApp: App {
    var body: some Scene {
        WindowGroup {
            SettingsView()
        }
    }
}

/// One-screen app: where Basil lives + the Siri token. Everything else
/// happens through Siri (AskBasilIntent) or the Basil PWA.
struct SettingsView: View {
    @AppStorage("basilServerURL") private var serverURL = "https://basil-app.vercel.app"
    @State private var token: String = KeychainHelper.read(key: "basilSiriToken") ?? ""
    @State private var saved = false
    @State private var testResult: String?
    @State private var testing = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("https://basil-app.vercel.app", text: $serverURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    SecureField("bsl_…", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Siri token")
                } footer: {
                    Text("Generate it in Basil → Settings → Developer → Siri Shortcut setup. Stored only in this device's Keychain.")
                }
                Section {
                    Button(saved ? "Saved ✓" : "Save") {
                        KeychainHelper.save(key: "basilSiriToken", value: token.trimmingCharacters(in: .whitespacesAndNewlines))
                        saved = true
                        Task { try? await Task.sleep(for: .seconds(2)); saved = false }
                    }
                    .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    Button(testing ? "Asking Basil…" : "Test connection") {
                        testing = true
                        testResult = nil
                        Task {
                            defer { testing = false }
                            do {
                                let answer = try await BasilAPI.ask("Reply with one short sentence confirming you can hear me.")
                                testResult = "✓ \(answer)"
                            } catch {
                                testResult = "✗ \(error.localizedDescription)"
                            }
                        }
                    }
                    .disabled(testing)

                    if let testResult {
                        Text(testResult).font(.footnote).foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("Once saved, just say: “Hey Siri, Ask Basil.”")
                }
            }
            .navigationTitle("Basil × Siri")
        }
    }
}
