import SwiftUI

@MainActor
class FeedViewModel: ObservableObject {
    @Published var events: [BasilEvent] = []
    @Published var isLoading = false
    @Published var error: String?

    func load() async {
        isLoading = true
        error = nil
        do {
            events = try await BasilAPI.shared.events(limit: 50)
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}

struct FeedView: View {
    @StateObject private var vm = FeedViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading && vm.events.isEmpty {
                    ProgressView("Loading signals…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let err = vm.error {
                    ErrorView(message: err) { Task { await vm.load() } }
                } else if vm.events.isEmpty {
                    EmptyStateView(icon: "antenna.radiowaves.left.and.right", title: "No signals yet", message: "Events from Gmail, Slack, and Calendar will appear here")
                } else {
                    List(vm.events) { event in
                        EventRow(event: event)
                            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    }
                    .listStyle(.plain)
                    .refreshable { await vm.load() }
                }
            }
            .navigationTitle("Feed")
            .navigationBarTitleDisplayMode(.large)
        }
        .task { await vm.load() }
    }
}

struct EventRow: View {
    let event: BasilEvent

    var sourceIcon: String {
        switch event.source {
        case "gmail":    return "envelope.fill"
        case "slack":    return "bubble.left.fill"
        case "calendar": return "calendar"
        case "zoom":     return "video.fill"
        default:         return "circle.fill"
        }
    }

    var sourceColor: Color {
        switch event.source {
        case "gmail":    return .red
        case "slack":    return .purple
        case "calendar": return .blue
        case "zoom":     return .teal
        default:         return .gray
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: sourceIcon)
                .foregroundStyle(sourceColor)
                .frame(width: 20)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 4) {
                Text(event.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)

                if let body = event.body, !body.isEmpty {
                    Text(body)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                HStack(spacing: 6) {
                    if let from = event.from {
                        Text(from)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if let date = event.createdAt {
                        Text("·")
                            .foregroundStyle(.tertiary)
                        Text(date.relativeFormatted)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }

                if let tags = event.tags, !tags.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 4) {
                            ForEach(tags, id: \.self) { tag in
                                Text(tag)
                                    .font(.caption2)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color(.systemGray5))
                                    .clipShape(Capsule())
                            }
                        }
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}
