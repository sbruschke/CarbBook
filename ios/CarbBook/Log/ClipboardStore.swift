import CarbBookCore
import CarbBookKit
import Observation
import SwiftUI
import UIKit

/// The in-app clipboard as the screens see it (log copy spec 2026-10-07). Kept in UserDefaults by
/// `LogClipboard`, per device and never synced; one shared instance so a copy in the Log shows up in
/// the Calculator and the plan editor straight away.
@Observable
@MainActor
final class ClipboardStore {
    static let shared = ClipboardStore()

    private(set) var current: LogClipboard? = LogClipboard.load()

    /// Copies rows from a log entry: in-app for pasting into the Calculator or a plan slot, and a
    /// plain-text list on the system clipboard for pasting anywhere else.
    func copy(source: String, items: [LogItemData], catalog: Catalog) {
        let clipboard = LogClipboard(source: source, items: clipItemsFromLog(items))
        LogClipboard.save(clipboard)
        current = LogClipboard.load()
        UIPasteboard.general.string = LogClipboard.text(source: source, items: items, catalog: catalog)
    }

    func clear() {
        LogClipboard.save(nil)
        current = nil
    }
}

/// "Copied: Lunch · Tue 6 Oct · 3 items — Paste / Clear", shown at the top of an item list while
/// the clipboard holds something. Pasting appends and keeps the clipboard, so the same meal can go
/// into several slots.
struct PasteRow: View {
    let onPaste: (LogClipboard) -> Void

    var body: some View {
        let store = ClipboardStore.shared
        if let clipboard = store.current {
            VStack(alignment: .leading, spacing: 6) {
                Label("Copied: \(clipboard.source) · \(clipboard.items.count) \(clipboard.items.count == 1 ? "item" : "items")",
                      systemImage: "doc.on.clipboard")
                    .font(.callout)
                HStack {
                    Button("Paste") { onPaste(clipboard) }
                    Spacer()
                    Button("Clear", role: .destructive) { store.clear() }
                }
                .buttonStyle(.borderless)
            }
            .accessibilityElement(children: .contain)
        }
    }
}
