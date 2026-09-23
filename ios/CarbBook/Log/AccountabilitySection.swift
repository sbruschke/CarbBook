import CarbBookCore
import SwiftUI
import UIKit

/// The copy-pasteable accountability message for a log entry (core: `accountabilityText`).
///
/// The text is shown in full and is selectable, so it can still be copied by hand if the pasteboard
/// write is refused. It restates only what is entered above it — it is never a dose recommendation.
struct AccountabilitySection: View {
    let eatenAt: Date
    let bgMgdl: Double?
    let carbsG: Double
    let units: Double?

    @State private var copied = false

    private var text: String {
        accountabilityText(
            AccountabilityInput(
                when: accountabilityStamp.string(from: eatenAt), bgMgdl: bgMgdl, carbsG: carbsG, units: units))
    }

    var body: some View {
        Section("Accountability text") {
            Text(text).textSelection(.enabled)
            Button {
                UIPasteboard.general.string = text
                copied = true
            } label: {
                Label(copied ? "Copied" : "Copy text", systemImage: copied ? "checkmark" : "doc.on.doc")
            }
            // A stale "Copied" would claim the pasteboard holds something it no longer does.
            .onChange(of: text) { copied = false }
        }
    }
}
