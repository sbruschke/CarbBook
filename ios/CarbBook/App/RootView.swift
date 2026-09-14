import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        TabView {
            // Screen tabs are added here by later tasks, in this order:
            // Calculator, Foods, Meals, Log, Settings.
            SignedInHome()
                .tabItem { Label("Home", systemImage: "house") }
        }
        .fullScreenCover(isPresented: Binding(get: { app.needsLogin }, set: { _ in })) {
            LoginView()
        }
    }
}

/// Shown until the Calculator tab replaces it (Task 11).
struct SignedInHome: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        NavigationStack {
            List {
                LabeledContent("Signed in as", value: app.user?.username ?? "—")
                LabeledContent("Pending changes", value: String((try? app.store.pendingCount()) ?? 0))
                Text(app.usdaStatus)
            }
            .navigationTitle("CarbBook")
        }
    }
}
