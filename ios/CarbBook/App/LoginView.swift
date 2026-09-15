import CarbBookKit
import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var app
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Username", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                } footer: {
                    Text("Server: \(AppModel.serverURL.host() ?? "")")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section {
                    Button {
                        Task { await signIn() }
                    } label: {
                        if busy { ProgressView() } else { Text("Sign in").frame(maxWidth: .infinity) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || username.isEmpty || password.isEmpty)
                }
                Section {
                    Text("Changes made while signed out stay on this phone and sync after you sign in.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("CarbBook")
        }
        .interactiveDismissDisabled()
    }

    private func signIn() async {
        busy = true
        defer { busy = false }
        do {
            try await app.signIn(username: username, password: password)
            password = ""
            error = nil
        } catch APIError.unauthorized {
            error = "Wrong username or password."
        } catch APIError.server(429, _, _) {
            error = "Too many attempts. Wait 15 minutes and try again."
        } catch APIError.transport {
            error = "Can't reach the server. Check your connection."
        } catch {
            self.error = "Sign-in failed: \(error)"
        }
    }
}
