import SwiftUI

@MainActor
class BriefingViewModel: ObservableObject {
    @Published var briefing: BriefingResponse?
    @Published var isLoading = false
    @Published var error: String?

    func load() async {
        isLoading = true
        error = nil
        do {
            briefing = try await BasilAPI.shared.briefing()
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}

struct BriefingView: View {
    @StateObject private var vm = BriefingViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading {
                    ProgressView("Generating briefing…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let err = vm.error {
                    ErrorView(message: err) { Task { await vm.load() } }
                } else if let b = vm.briefing {
                    BriefingContent(briefing: b)
                } else {
                    EmptyStateView(
                        icon: "newspaper",
                        title: "Daily Briefing",
                        message: "Tap to generate your morning briefing"
                    ) { Task { await vm.load() } }
                }
            }
            .navigationTitle("Briefing")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { Task { await vm.load() } } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(vm.isLoading)
                }
            }
        }
        .task { await vm.load() }
    }
}

struct BriefingContent: View {
    let briefing: BriefingResponse

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let headline = briefing.headline {
                    Text(headline)
                        .font(.title2.bold())
                        .padding(.horizontal)
                }

                if let summary = briefing.summary {
                    Text(summary)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal)
                }

                if let sections = briefing.sections, !sections.isEmpty {
                    ForEach(sections) { section in
                        BriefingSectionCard(section: section)
                            .padding(.horizontal)
                    }
                }

                if let date = briefing.generatedAt {
                    Text("Generated \(date.relativeFormatted)")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal)
                        .padding(.bottom)
                }
            }
            .padding(.top)
        }
    }
}

struct BriefingSectionCard: View {
    let section: BriefingResponse.BriefingSection

    var priorityColor: Color {
        switch section.priority {
        case "high":   return .red
        case "medium": return .orange
        default:       return .blue
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(section.title)
                    .font(.headline)
                Spacer()
                if let p = section.priority {
                    Text(p.uppercased())
                        .font(.caption2.bold())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(priorityColor.opacity(0.15))
                        .foregroundStyle(priorityColor)
                        .clipShape(Capsule())
                }
            }
            Text(section.body)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding()
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
