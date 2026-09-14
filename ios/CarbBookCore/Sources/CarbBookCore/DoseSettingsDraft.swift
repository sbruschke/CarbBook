import Foundation

/// The server's dose_settings push checks (server-data plan, sync/tables.ts), so the Settings
/// editor refuses to save a version the server would reject. Messages match the server's.
public func validateDoseSettings(_ s: DoseSettingsData) -> String? {
    // Server field order (tables.ts dose_settings spec): effective_from, windows, correction, rounding.
    if s.effectiveFrom < 0 { return "effective_from must be >= 0" }
    if s.windows.isEmpty || s.windows.count > 24 { return "windows must be an array of 1-24 windows" }
    var starts = Set<Int>()
    for window in s.windows {
        if window.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "every window needs a name" }
        guard let minutes = try? parseHHMM(window.start) else {
            return "window \"\(window.name)\" has invalid start \"\(window.start)\""
        }
        if !starts.insert(minutes).inserted { return "duplicate window start \(window.start)" }
        if !window.ratioGPerUnit.isFinite || window.ratioGPerUnit <= 0 {
            return "window \"\(window.name)\" needs ratio_g_per_unit > 0"
        }
    }
    let c = s.correction
    if !c.threshold.isFinite || c.threshold < 0 { return "correction.threshold must be >= 0" }
    if !c.step.isFinite || c.step <= 0 { return "correction.step must be > 0" }
    if !c.unitsPerStep.isFinite || c.unitsPerStep < 0 { return "correction.units_per_step must be >= 0" }
    if !["started", "full", "proportional"].contains(c.mode) { return "correction.mode must be started, full or proportional" }
    let r = s.rounding
    if !r.increment.isFinite || r.increment <= 0 { return "rounding.increment must be > 0" }
    if let below = r.roundDownBelowBg, !below.isFinite || below < 0 {
        return "rounding.round_down_below_bg must be null or >= 0"
    }
    return nil
}

/// A new dose settings version: windows sorted by start, fresh id. Old versions are never edited.
public func newDoseSettingsVersion(from draft: DoseSettingsData, effectiveFrom: Int64, newId: () -> Id) -> DoseSettingsData {
    var version = draft
    version.id = newId()
    version.effectiveFrom = effectiveFrom
    version.windows = draft.windows.sorted { ((try? parseHHMM($0.start)) ?? 0) < ((try? parseHHMM($1.start)) ?? 0) }
    return version
}
