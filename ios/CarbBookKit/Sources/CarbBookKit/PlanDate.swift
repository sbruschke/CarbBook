import Foundation

/// `plan_entry.date` is a local calendar date, not an instant: "2026-09-16" means that day wherever
/// the user is. Every conversion goes through here so no screen invents its own formatter.
public enum PlanDate {
    /// The local calendar date of an instant, as "YYYY-MM-DD".
    public static func string(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// "YYYY-MM-DD" → local noon on that day. Noon, not midnight, so a DST transition can never
    /// push the value onto the previous or next day when it is formatted back.
    public static func date(_ text: String, calendar: Calendar = .current) -> Date? {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              (1...12).contains(month), (1...31).contains(day) else { return nil }
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = 12
        guard let made = calendar.date(from: components), string(made, calendar: calendar) == text else { return nil }
        return made
    }

    /// The seven dates of the week containing `text`, starting on the calendar's first weekday.
    /// An unparseable date yields an empty week rather than a crash.
    public static func week(containing text: String, calendar: Calendar = .current) -> [String] {
        guard let day = date(text, calendar: calendar) else { return [] }
        let weekday = calendar.component(.weekday, from: day)
        let offset = (weekday - calendar.firstWeekday + 7) % 7
        guard let start = calendar.date(byAdding: .day, value: -offset, to: day) else { return [] }
        return (0..<7).compactMap { index in
            calendar.date(byAdding: .day, value: index, to: start).map { string($0, calendar: calendar) }
        }
    }

    /// `text` moved by whole days; returns `text` unchanged when it cannot be parsed.
    public static func shift(_ text: String, byDays days: Int, calendar: Calendar = .current) -> String {
        guard let day = date(text, calendar: calendar),
              let moved = calendar.date(byAdding: .day, value: days, to: day) else { return text }
        return string(moved, calendar: calendar)
    }

    /// Normalizes a window name for identity comparisons: trimmed, case-insensitive (folded to
    /// lowercase). The server rejects a second live slot for the same (date, window) even when the
    /// window name differs only by case or surrounding whitespace (`duplicate_slot`), so every place
    /// that looks up, keys, copies or dismisses a slot must agree on the same normalized form.
    public static func normalizedWindowName(_ windowName: String) -> String {
        windowName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// The per-device dismissal key, same format as the web app's: "<date>|<window>". The window
    /// name is normalized so a dismissal survives a slot whose window name differs only by case or
    /// whitespace (see `normalizedWindowName`).
    public static func slotKey(date: String, windowName: String) -> String {
        "\(date)|\(normalizedWindowName(windowName))"
    }
}
