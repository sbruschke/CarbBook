import CarbBookCore
import CarbBookKit
import SwiftUI

/// The webhook a log posts to. Set per device on purpose: the URL is the whole secret for posting
/// into a chat, so it stays in this device's Keychain rather than syncing to the server and to
/// every other device that signs in.
struct WebhookSettingsView: View {
    @State private var url = Keychain.loadWebhook() ?? ""
    @State private var message: String?
    @State private var sending = false

    private var problem: String? {
        url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : webhookUrlProblem(url)
    }

    var body: some View {
        Form {
            Section {
                TextField("https://discord.com/api/webhooks/…", text: $url, axis: .vertical)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .onChange(of: url) { message = nil }
                if let problem {
                    Text(problem).foregroundStyle(.red).font(.footnote)
                }
            } header: {
                Text("Webhook URL")
            } footer: {
                Text("""
                When this device logs an entry, the accountability text is posted here, with a breakdown of what was in the \
                meal. Paste a Discord channel's webhook URL (Channel settings → Integrations → Webhooks → Copy Webhook URL). \
                Editing an entry later posts nothing — only logging does.
                """)
            }
            Section {
                Button("Save webhook") { save() }
                Button("Send test message") { Task { await sendTest() } }
                    .disabled(sending || url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if !url.isEmpty {
                    Button("Remove webhook", role: .destructive) {
                        Keychain.deleteWebhook()
                        url = ""
                        message = "Webhook removed. Logging posts nothing from this device."
                    }
                }
            } footer: {
                Text("""
                This URL is kept on this device only — it is never synced to the server or to your other devices. Anyone who \
                has it can post to that channel, so treat it like a password.
                """)
            }
            if let message {
                Section { Text(message).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle("Webhook")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func save() {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            Keychain.deleteWebhook()
            message = "Webhook cleared. Logging posts nothing from this device."
            return
        }
        if let problem = webhookUrlProblem(trimmed) {
            message = problem
            return
        }
        do {
            try Keychain.saveWebhook(trimmed)
            url = trimmed
            message = isDiscordWebhookUrl(trimmed)
                ? "Saved. New log entries post to Discord."
                : "Saved. New log entries post to this URL."
        } catch {
            message = "Could not save the webhook: \(error)"
        }
    }

    /// A test post says what it is, so a channel that receives one knows why.
    private func sendTest() async {
        sending = true
        defer { sending = false }
        let stamp = DateFormatter()
        stamp.dateStyle = .short
        stamp.timeStyle = .long
        let content = webhookMessage(
            AccountabilityInput(when: stamp.string(from: Date()), bgMgdl: 120, carbsG: 45, units: 4),
            items: [
                WebhookItemLine(name: "CarbBook test message", amount: "", carbsG: .nan),
                WebhookItemLine(name: "Example food", amount: "1 cup", carbsG: 45),
            ])
        do {
            try await WebhookSender().send(content, to: url.trimmingCharacters(in: .whitespacesAndNewlines))
            message = "Test message sent."
        } catch {
            message = error.message
        }
    }
}
