import SwiftUI

@MainActor
class ChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var inputText = ""
    @Published var isLoading = false
    @Published var error: String?

    func send() async {
        let q = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !isLoading else { return }

        inputText = ""
        messages.append(ChatMessage(role: "user", content: q))
        isLoading = true
        error = nil

        do {
            let historyToSend = messages.dropLast()  // exclude the just-added user message from history
            let res = try await BasilAPI.shared.ask(q, history: Array(historyToSend))
            messages.append(ChatMessage(role: "assistant", content: res.answer))
        } catch {
            self.error = error.localizedDescription
            messages.removeLast()  // remove the user message on failure
        }

        isLoading = false
    }

    func clear() {
        messages.removeAll()
        error = nil
    }
}

struct ChatView: View {
    @StateObject private var vm = ChatViewModel()
    @FocusState private var inputFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if vm.messages.isEmpty {
                    EmptyStateView(
                        icon: "brain.head.profile",
                        title: "Ask Stig",
                        message: "Ask about your emails, calendar, projects, or anything else"
                    )
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(spacing: 12) {
                                ForEach(vm.messages) { msg in
                                    MessageBubble(message: msg)
                                        .id(msg.id)
                                }
                                if vm.isLoading {
                                    TypingIndicator()
                                        .id("typing")
                                }
                            }
                            .padding()
                        }
                        .onChange(of: vm.messages.count) {
                            withAnimation {
                                proxy.scrollTo(vm.messages.last?.id ?? "typing", anchor: .bottom)
                            }
                        }
                    }
                }

                if let err = vm.error {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal)
                }

                Divider()
                ChatInputBar(text: $vm.inputText, isLoading: vm.isLoading, focused: $inputFocused) {
                    Task { await vm.send() }
                }
            }
            .navigationTitle("Stig")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Clear") { vm.clear() }
                        .disabled(vm.messages.isEmpty)
                }
            }
        }
    }
}

struct MessageBubble: View {
    let message: ChatMessage
    var isUser: Bool { message.role == "user" }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if isUser { Spacer(minLength: 50) }

            if !isUser {
                Image(systemName: "brain.head.profile")
                    .font(.caption)
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(.indigo)
                    .clipShape(Circle())
            }

            Text(message.content)
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(isUser ? Color.accentColor : Color(.systemGray6))
                .foregroundStyle(isUser ? .white : .primary)
                .clipShape(RoundedRectangle(cornerRadius: 16))

            if !isUser { Spacer(minLength: 50) }
        }
    }
}

struct TypingIndicator: View {
    @State private var dotOpacities = [1.0, 0.4, 0.1]

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Image(systemName: "brain.head.profile")
                .font(.caption)
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(.indigo)
                .clipShape(Circle())

            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .frame(width: 7, height: 7)
                        .opacity(dotOpacities[i])
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            Spacer()
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.6).repeatForever().delay(0)) {
                dotOpacities = [0.1, 1.0, 0.4]
            }
        }
    }
}

struct ChatInputBar: View {
    @Binding var text: String
    let isLoading: Bool
    var focused: FocusState<Bool>.Binding
    let onSend: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            TextField("Ask Stig…", text: $text, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.systemGray6))
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .focused(focused)
                .onSubmit { onSend() }

            Button(action: onSend) {
                Image(systemName: isLoading ? "stop.circle.fill" : "arrow.up.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(text.isEmpty || isLoading ? .gray : .accentColor)
            }
            .disabled(text.isEmpty || isLoading)
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.regularMaterial)
    }
}
