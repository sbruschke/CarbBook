import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        TabView {
            // Screen tabs are added here by later tasks, in this order:
            // Calculator, Foods, Meals, Log, Settings.
            CalculatorView()
                .tabItem { Label("Calculator", systemImage: "function") }
            FoodsView()
                .tabItem { Label("Foods", systemImage: "carrot") }
            MealsView()
                .tabItem { Label("Meals", systemImage: "fork.knife") }
            LogView()
                .tabItem { Label("Log", systemImage: "list.bullet.rectangle") }
        }
        .fullScreenCover(isPresented: Binding(get: { app.needsLogin }, set: { _ in })) {
            LoginView()
        }
    }
}
