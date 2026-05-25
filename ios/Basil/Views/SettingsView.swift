import SwiftUI

struct SettingsView: View {
    @AppStorage("basil_base_url") private var baseURL = "https://ag-contracts.vercel.app"
    @State private var apiToken = BasilConfig.shared.apiToken
    @State private var showToken = false
    @State private var testResult: String?
    @State private var isTesting = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Image(systemName: "globe")
                            .foregroundStyle(.blue)
                            .frame(width: 24)
                        TextField("Server URL", text: $baseURL)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                    }
                } header: {
                    Text("Server")
                } footer: {
                    Text("Your Basil deployment URL.")
                }

                Section {
                    HStack {
                        Image(systemName: "key.fill")
                            .foregroundStyle(.orange)
                            .frame(width: 24)
                        if showToken {
                            TextField("API Token", text: $apiToken)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .monospaced()
                        } else {
                            SecureField("API Token", text: $apiToken)
                                .monospaced()
                        }
                        Button { showToken.toggle() } label: {
                            Image(systemName: showToken ? "eye.slash" : "eye")
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Authentication")
                } footer: {
                    Text("Set STIG_API_TOKEN in Vercel env vars. Find it in your Vercel project settings.")
                }

                Section {
                    Button {
                        Task { await testConnection() }
                    } label: {
                        HStack {
                            if isTesting {
                                ProgressView().scaleEffect(0.8)
                            } else {
                                Image(systemName: "bolt.fill")
                                    .foregroundStyle(.green)
                            }
                            Text(isTesting ? "Testing…" : "Test Connection")
                        }
                    }
                    .disabled(isTesting || apiToken.isEmpty)

                    if let result = testResult {
                        HStack {
                            Image(systemName: result.hasPrefix("✓") ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(result.hasPrefix("✓") ? .green : .red)
                            Text(result)
                                .font(.caption)
                        }
                    }
                }

                Section {
                    Button("Save", action: save)
                        .frame(maxWidth: .infinity)
                        .bold()
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    func save() {
        BasilConfig.shared.apiToken = apiToken
        dismiss()
    }

    func testConnection() async {
        isTesting = true
        testResult = nil
        // temporarily apply config
        BasilConfig.shared.apiToken = apiToken
        do {
            let status = try await BasilAPI.shared.status()
            testResult = "✓ Connected to \(status.name)"
        } catch {
            testResult = "✗ \(error.localizedDescription)"
        }
        isTesting = false
    }
}
