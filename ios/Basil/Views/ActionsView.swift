import SwiftUI

@MainActor
class ActionsViewModel: ObservableObject {
    @Published var actions: [BasilAction] = []
    @Published var isLoading = false
    @Published var error: String?

    func load() async {
        isLoading = true
        error = nil
        do {
            actions = try await BasilAPI.shared.actions()
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}

struct ActionsView: View {
    @StateObject private var vm = ActionsViewModel()

    var grouped: [(String, [BasilAction])] {
        let priorityOrder = ["high", "medium", "low", "none"]
        var dict: [String: [BasilAction]] = [:]
        for a in vm.actions {
            let key = a.priority ?? "none"
            dict[key, default: []].append(a)
        }
        return priorityOrder.compactMap { key in
            guard let items = dict[key], !items.isEmpty else { return nil }
            return (key, items)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading && vm.actions.isEmpty {
                    ProgressView("Loading actions…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let err = vm.error {
                    ErrorView(message: err) { Task { await vm.load() } }
                } else if vm.actions.isEmpty {
                    EmptyStateView(icon: "checkmark.circle", title: "No actions", message: "Actions extracted from your meetings and emails will appear here")
                } else {
                    List {
                        ForEach(grouped, id: \.0) { group, items in
                            Section(header: PriorityHeader(priority: group)) {
                                ForEach(items) { action in
                                    ActionRow(action: action)
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                    .refreshable { await vm.load() }
                }
            }
            .navigationTitle("Actions")
            .navigationBarTitleDisplayMode(.large)
        }
        .task { await vm.load() }
    }
}

struct PriorityHeader: View {
    let priority: String

    var color: Color {
        switch priority {
        case "high":   return .red
        case "medium": return .orange
        case "low":    return .blue
        default:       return .gray
        }
    }

    var body: some View {
        HStack {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(priority.capitalized)
                .font(.caption.uppercaseSmallCaps())
                .foregroundStyle(color)
        }
    }
}

struct ActionRow: View {
    let action: BasilAction

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(action.title)
                .font(.subheadline.weight(.medium))

            if let desc = action.description, !desc.isEmpty {
                Text(desc)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }

            HStack(spacing: 8) {
                if let project = action.project {
                    Label(project, systemImage: "folder")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if let due = action.dueDate {
                    Label(due.shortFormatted, systemImage: "clock")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
