import SwiftUI

@main
struct BasilApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    @State private var showSettings = false
    private let config = BasilConfig.shared

    var body: some View {
        if config.isConfigured {
            MainTabView(showSettings: $showSettings)
                .sheet(isPresented: $showSettings) {
                    SettingsView()
                }
        } else {
            OnboardingView(showSettings: $showSettings)
                .sheet(isPresented: $showSettings) {
                    SettingsView()
                }
        }
    }
}

struct MainTabView: View {
    @Binding var showSettings: Bool

    var body: some View {
        TabView {
            BriefingView()
                .tabItem {
                    Label("Briefing", systemImage: "newspaper")
                }

            ChatView()
                .tabItem {
                    Label("Stig", systemImage: "brain.head.profile")
                }

            FeedView()
                .tabItem {
                    Label("Feed", systemImage: "antenna.radiowaves.left.and.right")
                }

            ActionsView()
                .tabItem {
                    Label("Actions", systemImage: "checkmark.circle")
                }

            Button { showSettings = true } label: {
                Label("Settings", systemImage: "gearshape")
            }
            .tabItem {
                Label("Settings", systemImage: "gearshape")
            }
        }
    }
}

struct OnboardingView: View {
    @Binding var showSettings: Bool

    var body: some View {
        VStack(spacing: 32) {
            Spacer()

            VStack(spacing: 12) {
                Image(systemName: "brain.head.profile")
                    .font(.system(size: 64))
                    .foregroundStyle(.indigo)
                Text("Basil")
                    .font(.system(size: 44, weight: .bold, design: .rounded))
                Text("Your AI executive assistant")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 16) {
                FeatureRow(icon: "newspaper", color: .blue, title: "Daily Briefing", desc: "Morning intelligence digest")
                FeatureRow(icon: "brain.head.profile", color: .indigo, title: "Stig AI", desc: "Ask anything about your work")
                FeatureRow(icon: "antenna.radiowaves.left.and.right", color: .purple, title: "Signal Feed", desc: "Real-time emails, Slack, calendar")
                FeatureRow(icon: "checkmark.circle", color: .green, title: "Actions", desc: "Track commitments and next steps")
            }
            .padding(.horizontal, 32)

            Spacer()

            Button {
                showSettings = true
            } label: {
                Label("Connect to Basil", systemImage: "arrow.right.circle.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(.indigo)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }
            .padding(.horizontal, 32)
            .padding(.bottom, 40)
        }
    }
}

struct FeatureRow: View {
    let icon: String
    let color: Color
    let title: String
    let desc: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(color)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.bold())
                Text(desc).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
