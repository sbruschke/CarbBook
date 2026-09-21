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

    /// "9/20/26, 12:24:58 PM CDT" — the same shape the web produces with `toLocaleString`. The zone
    /// name is part of it on purpose: whoever receives the text has no reason to assume ours.
    private static let stamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .long
        return formatter
    }()

    private var text: String {
        accountabilityText(
            AccountabilityInput(
                when: Self.stamp.string(from: eatenAt), bgMgdl: bgMgdl, carbsG: carbsG, units: units))
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
