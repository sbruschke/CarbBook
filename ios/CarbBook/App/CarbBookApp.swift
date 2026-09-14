import SwiftUI

@main
struct CarbBookApp: App {
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .onAppear { app.start() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { app.foreground() }
                }
        }
    }
}
