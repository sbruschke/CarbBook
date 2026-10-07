import CarbBookCore
import Foundation

/// The in-app clipboard (log copy spec 2026-10-07): rows copied out of a log entry, waiting to be
/// pasted into the Calculator or a plan slot. Per device and never synced, like the plan
/// dismissals — a scratch space, not a record. One clipboard: a new copy replaces the old one.
public struct LogClipboard: Codable, Equatable, Sendable {
    /// What was copied, for the paste prompt: "Lunch · Tue 6 Oct" or "Calrose Rice".
    public var source: String
    public var items: [ClipItem]

    public init(source: String, items: [ClipItem]) {
        self.source = source; self.items = items
    }

    public static let key = "log.clipboard"

    /// Nil when empty or unreadable — anything malformed is an empty clipboard, never a half-right paste.
    public static func load(from defaults: UserDefaults = .standard) -> LogClipboard? {
        guard let data = defaults.data(forKey: key),
              let clipboard = try? JSONDecoder().decode(LogClipboard.self, from: data),
              !clipboard.items.isEmpty,
              clipboard.items.allSatisfy({ $0.amount.isFinite })
        else { return nil }
        return clipboard
    }

    public static func save(_ clipboard: LogClipboard?, to defaults: UserDefaults = .standard) {
        guard let clipboard, !clipboard.items.isEmpty, let data = try? JSONEncoder().encode(clipboard) else {
            defaults.removeObject(forKey: key)
            return
        }
        defaults.set(data, forKey: key)
    }

    /// Calculator rows for Paste: plain editable lines with fresh ids, carbs recomputed from today's
    /// food data like a loaded plan. A quick row gets no ref id, as when added by hand — logging
    /// points it at its own new row.
    public func calculatorLines(catalog: Catalog, newLineId: () -> String) -> [CalculatorLine] {
        items.map { item in
            CalculatorLine(id: newLineId(), refType: item.refType, refId: item.refType == .quick ? "" : item.refId,
                           displayName: itemDisplayName(item.refType, item.refId, label: item.label, catalog: catalog),
                           amount: item.amount, unit: item.unit, label: item.label)
        }
    }

    /// Plan-slot rows for Paste: new rows (no id), so saving creates fresh plan items. A quick row's
    /// ref id is replaced when the slot is saved, as for any new quick row.
    public func planItems() -> [PlanEditing.DraftItem] {
        items.map { item in
            PlanEditing.DraftItem(id: nil, refType: item.refType, refId: item.refType == .quick ? "" : item.refId,
                                  amount: item.amount, unit: item.unit, label: item.label)
        }
    }

    /// The plain-text form put on the system clipboard alongside, for pasting anywhere else.
    public static func text(source: String, items: [LogItemData], catalog: Catalog) -> String {
        ([source] + webhookItemLines(for: items, catalog: catalog).map { line in
            "- " + [line.name, line.amount, "\(LogReportHtml.trim(line.carbsG, 1)) g"].filter { !$0.isEmpty }.joined(separator: " · ")
        }).joined(separator: "\n")
    }
}
