import CarbBookCore
import Foundation

/// Food editor state and save rules (any-unit foods addendum), kept out of the SwiftUI target so it
/// runs in Linux tests. Mirrors web/src/foods/FoodEditor.tsx:
/// - carbs are entered per 100 g, or "from label" in any unit (g, volume, named piece/serving);
/// - saving one carb basis keeps the other stored basis unless the user removes it;
/// - save needs at least one valid basis (per 100 g, per 100 ml, or a piece with carbs);
/// - every number field parses strictly; typed-but-malformed text is an error. Label amount and portion
///   quantity use `NumberParsing.parseAmount` (fractions allowed); carbs, fiber, density, grams and label
///   weight use `NumberParsing.parseNonNegative` (decimals only — a fractional gram is never an entry).
public struct FoodForm: Equatable, Sendable {
    public enum CarbsMode: String, Sendable { case per100g, label }

    public struct Portion: Identifiable, Equatable, Sendable {
        public var id: Id
        public var label: String
        /// "count" | "serving" | "volume"
        public var kind: String
        public var quantity: String
        /// Empty = unknown weight.
        public var grams: String
        /// Empty = unknown carbs. Ignored (never saved) on volume portions.
        public var carbsG: String

        public init(id: Id, label: String, kind: String, quantity: String, grams: String, carbsG: String) {
            self.id = id; self.label = label; self.kind = kind; self.quantity = quantity; self.grams = grams; self.carbsG = carbsG
        }
    }

    public struct Output: Equatable, Sendable {
        public var food: FoodData
        public var portions: [PortionData]
        /// Existing portions of the edited food that are no longer in the form (to soft-delete).
        public var removedPortionIds: [Id]
    }

    public let base: FoodData?
    public let basePortionIds: [Id]
    public var name: String
    public var brand: String
    public var carbsMode: CarbsMode
    public var carbsText: String
    /// One of `FoodLabel.units`.
    public var labelUnit: String
    public var labelAmount: String
    public var labelCarbs: String
    public var labelWeight: String
    public var labelName: String
    public var fiber: String
    public var density: String
    public var notes: String
    public var portions: [Portion]
    /// Stored bases the user explicitly removed.
    public var removedBaseG = false
    public var removedBaseMl = false

    public init(food: FoodData?, portions: [PortionData]) {
        base = food
        basePortionIds = portions.map(\.id)
        name = food?.name ?? ""
        brand = food?.brand ?? ""
        carbsText = NumberParsing.editText(food?.carbsPer100g)
        fiber = NumberParsing.editText(food?.fiberPer100g)
        density = NumberParsing.editText(food?.densityGPerMl)
        notes = food?.notes ?? ""
        self.portions = portions.map {
            Portion(id: $0.id, label: $0.label, kind: $0.kind, quantity: NumberParsing.editText($0.quantity),
                    grams: NumberParsing.editText($0.grams), carbsG: NumberParsing.editText($0.carbsG))
        }
        // Open in the mode the stored basis was entered in (web `initialLabelFields`).
        carbsMode = .per100g
        labelUnit = "g"
        labelAmount = ""
        labelCarbs = ""
        labelWeight = ""
        labelName = ""
        guard let food, food.carbsPer100g == nil else { return }
        if let ml = food.carbsPer100ml {
            carbsMode = .label
            labelUnit = "ml"
            labelAmount = "100"
            labelCarbs = NumberParsing.editText(ml)
        } else if let piece = portions.first(where: { $0.kind != "volume" && $0.carbsG != nil }) {
            carbsMode = .label
            labelUnit = FoodLabel.other
            labelAmount = NumberParsing.editText(piece.quantity)
            labelCarbs = NumberParsing.editText(piece.carbsG)
            labelWeight = NumberParsing.editText(piece.grams)
            labelName = piece.label
        }
    }

    public var isUsdaCopy: Bool { base?.source == "usda" }

    fileprivate static func blank(_ text: String) -> Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private enum Field: Equatable {
        case blank, value(Double), malformed

        init(_ text: String) {
            if FoodForm.blank(text) { self = .blank } else if let value = NumberParsing.parseNonNegative(text) { self = .value(value) } else { self = .malformed }
        }

        var value: Double? { if case .value(let v) = self { return v } else { return nil } }
    }

    /// The current label entry's basis, or its error.
    public var labelEntry: Result<FoodLabel.Basis, LabelError> {
        if NumberParsing.isMalformed(labelAmount, using: NumberParsing.parseAmount) { return .failure(LabelError("Amount isn't a valid number.")) }
        if NumberParsing.isMalformed(labelCarbs, using: NumberParsing.parseNonNegative) { return .failure(LabelError("Carbs isn't a valid number.")) }
        if labelUnit != "g", NumberParsing.isMalformed(labelWeight, using: NumberParsing.parseNonNegative) {
            return .failure(LabelError("Weight isn't a valid number."))
        }
        return FoodLabel.basis(unit: labelUnit, amount: NumberParsing.parseAmount(labelAmount), carbs: NumberParsing.parseNonNegative(labelCarbs),
                               weight: labelUnit == "g" ? nil : NumberParsing.parseNonNegative(labelWeight), label: labelName)
    }

    /// One-line feedback under the label fields.
    public var labelResultText: String {
        if Self.blank(labelAmount) || Self.blank(labelCarbs) { return "Enter the amount and carbs from the label." }
        switch labelEntry {
        case .failure(let error): return error.message
        case .success(let basis):
            if labelUnit == "g", let g = basis.carbsPer100g { return "= \(FoodLabel.trim2(g)) g carbs per 100 g" }
            if let ml = basis.carbsPer100ml { return "= \(FoodLabel.trim2(ml)) g carbs per 100 ml" }
            let label = labelName.trimmingCharacters(in: .whitespacesAndNewlines)
            return "Adds \"\(label.isEmpty ? "piece" : label)\": \(labelCarbs.trimmingCharacters(in: .whitespaces)) g carbs"
        }
    }

    private var labelWeightValue: Double? {
        guard labelUnit != "g", let weight = NumberParsing.parseNonNegative(labelWeight), weight > 0 else { return nil }
        return weight
    }

    /// Whether saving writes `carbs_per_100g` / `carbs_per_100ml` from the current entry.
    public var editsG: Bool { carbsMode == .per100g || labelUnit == "g" || (labelUnit == FoodLabel.other && labelWeightValue != nil) }
    public var editsMl: Bool { carbsMode == .label && isVolumeUnit(labelUnit) }
    /// The stored basis that saving keeps (shown as "Also saved: …" with a remove button).
    public var keptG: Double? { !editsG && !removedBaseG ? base?.carbsPer100g : nil }
    public var keptMl: Double? { !editsMl && !removedBaseMl ? base?.carbsPer100ml : nil }

    /// The carbsPer100ml a fresh volume reading would save, from the current (not yet saved) form
    /// fields — the label entry if it is a volume reading, else the first volume portion row, mirroring
    /// `build()`. Best-effort: ignores rows with blank or malformed fields, and returns nil while the
    /// readings conflict (save reports that).
    private var portionVolumeCarbsCandidate: Double? {
        var candidates: [(source: String, value: Double)] = []
        if carbsMode == .label, case .success(let basis) = labelEntry, let ml = basis.carbsPer100ml { candidates.append(("the label entry", ml)) }
        for row in portions where row.kind == "volume" && isVolumeUnit(row.label) {
            guard let quantity = NumberParsing.parseAmount(row.quantity), quantity > 0,
                  let carbs = NumberParsing.parseNonNegative(row.carbsG) else { continue }
            let mapped = PortionEntry.map(.init(unit: row.label, quantity: quantity, grams: nil, carbs: carbs))
            if let value = mapped.carbsPer100ml, isValidCarbsPer100ml(value) { candidates.append(("row", value)) }
        }
        guard candidates.contains(where: { $0.source != "the label entry" }), case .success(let value) = Self.resolveVolume(candidates) else { return nil }
        return value
    }

    /// Web `resolveVolumeCarbs`: every pair of fresh carbs-per-100-ml readings must agree within 1%
    /// (relative to the larger); the first disagreeing pair blocks save, naming both. When all agree the
    /// first reading wins (the label entry is appended first when present, else the first portion row).
    static func resolveVolume(_ candidates: [(source: String, value: Double)]) -> Result<Double?, LabelError> {
        for i in candidates.indices {
            for j in candidates.indices where j > i {
                let a = candidates[i], b = candidates[j]
                let diff = abs(a.value - b.value) / max(abs(a.value), abs(b.value), 1e-9)
                if diff > 0.01 {
                    return .failure(LabelError("\(a.source) and \(b.source) imply different carbs per 100 ml; enter it in one place only."))
                }
            }
        }
        return .success(candidates.first?.value)
    }

    /// Shown under the Portions section when a volume-unit portion's carbs would overwrite an
    /// already-saved `carbsPer100ml` that's more than 1% different from it.
    public var portionVolumeCarbsNote: String? {
        guard let existing = base?.carbsPer100ml, existing.isFinite, let candidate = portionVolumeCarbsCandidate else { return nil }
        guard abs(candidate - existing) > abs(existing) * 0.01 else { return nil }
        return "This replaces saved carbs per volume (\(FoodLabel.trim2(existing)) g per 100 ml)."
    }

    /// Adds a portion, or updates the matching one (re-entering a label updates it rather than duplicating it).
    static func merge(_ rows: [Portion], _ patch: FoodLabel.PortionPatch, newId: () -> Id) -> [Portion] {
        let key = patch.label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let index = rows.firstIndex {
            patch.kind == "volume"
                ? $0.kind == "volume" && $0.label == patch.label
                : $0.kind != "volume" && $0.label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == key
        }
        let row = Portion(id: index.map { rows[$0].id } ?? newId(), label: patch.label, kind: patch.kind,
                          quantity: NumberParsing.editText(patch.quantity), grams: NumberParsing.editText(patch.grams),
                          carbsG: NumberParsing.editText(patch.carbsG))
        var next = rows
        if let index { next[index] = row } else { next.append(row) }
        return next
    }

    /// Validates and builds the records to save, or returns every problem found.
    public func build(newId: () -> Id) -> Result<Output, FoodFormErrors> {
        var problems: [String] = []
        let copy = isUsdaCopy
        let foodId = base.map { copy ? newId() : $0.id } ?? newId()
        if Self.blank(name) { problems.append("Name is required.") }
        var carbsPer100g: Double?
        var carbsPer100ml: Double?
        var rows = portions
        /// A fresh (this-edit) source of `carbsPer100ml`, so two that disagree can be reported by name
        /// instead of one silently overwriting the other.
        var mlCandidates: [(source: String, value: Double)] = []

        switch carbsMode {
        case .per100g:
            if Self.blank(carbsText) {
                problems.append("Carbs are missing: enter them from the label.")
            } else if let value = NumberParsing.parseNonNegative(carbsText), isValidCarbsPer100g(value) {
                carbsPer100g = value
            } else {
                problems.append("Carbs per 100 g must be a number from 0 to 100.")
            }
        case .label:
            switch labelEntry {
            case .failure(let error): problems.append(error.message)
            case .success(let basis):
                carbsPer100g = basis.carbsPer100g
                carbsPer100ml = basis.carbsPer100ml
                if let ml = basis.carbsPer100ml { mlCandidates.append(("the label entry", ml)) }
                if let patch = basis.portion { rows = Self.merge(rows, patch, newId: newId) }
                if labelUnit == "g", let amount = NumberParsing.parseAmount(labelAmount), amount > 0 {
                    rows = Self.merge(rows, FoodLabel.PortionPatch(label: FoodLabel.labelServing, kind: "serving", quantity: 1,
                                                                   grams: amount, carbsG: nil), newId: newId)
                }
            }
        }
        if !editsG { carbsPer100g = keptG }
        if !editsMl { carbsPer100ml = keptMl }

        let fiberField = Field(fiber)
        let fiberValue = fiberField.value
        if fiberField == .malformed || (fiberValue.map { $0 > 100 } ?? false) {
            problems.append("Fiber per 100 g must be a number from 0 to 100.")
        }
        if let fiberValue, let carbsPer100g, fiberValue > carbsPer100g {
            problems.append("Fiber per 100 g cannot be more than carbs per 100 g.")
        }
        let densityField = Field(density)
        let densityValue = densityField.value
        if densityField == .malformed || (densityValue.map { !($0 > 0) } ?? false) {
            problems.append("Density must be greater than 0.")
        }

        var saved: [PortionData] = []
        for (i, row) in rows.enumerated() {
            let n = i + 1
            let label = row.label.trimmingCharacters(in: .whitespacesAndNewlines)
            let isVolume = row.kind == "volume"
            let quantity = NumberParsing.parseAmount(row.quantity)
            let grams = Field(row.grams)
            // A volume unit's carbs never land on the portion row (server rule); they set
            // carbsPer100ml instead. Like web, every row's typed carbs must still be in the portion
            // carbs range, and a volume row's implied carbs per 100 ml is range-checked below too.
            let carbs = Field(row.carbsG)
            if label.isEmpty { problems.append("Portion \(n) needs a label.") }
            if isVolume && !isVolumeUnit(row.label) { problems.append("Portion \(n): pick a volume unit.") }
            if !(quantity.map { $0 > 0 } ?? false) { problems.append("Portion \(n) needs a quantity above 0.") }
            if grams == .malformed || (grams.value.map { !isValidPortionGrams($0) } ?? false) {
                problems.append("Portion \(n): grams must be a number above 0.")
            }
            if carbs == .malformed || (carbs.value.map { !isValidPortionCarbs($0) } ?? false) {
                problems.append("Portion \(n): carbs must be a number from 0 to \(NumberParsing.editText(Units.maxPortionCarbsG)).")
            }
            if grams == .blank && carbs == .blank { problems.append("Portion \(n) needs grams or carbs.") }

            var mapped: PortionEntry.Output?
            if isVolume, let quantity, quantity > 0, isVolumeUnit(row.label), grams != .malformed, carbs != .malformed {
                mapped = PortionEntry.map(.init(unit: row.label, quantity: quantity, grams: grams.value, carbs: carbs.value))
                if let candidate = mapped?.carbsPer100ml {
                    if isValidCarbsPer100ml(candidate) {
                        mlCandidates.append(("Portion \(n)", candidate))
                    } else {
                        problems.append("Portion \(n): carbs per 100 ml must be a number from 0 to \(NumberParsing.editText(Units.maxCarbsPer100ml)).")
                    }
                }
            }

            // A USDA copy gets fresh portion ids; otherwise ids are kept (new rows already have fresh ones).
            let id = copy && basePortionIds.contains(row.id) ? newId() : row.id
            if isVolume {
                // A carbs-only volume row (no weight) saves no portion row at all — only carbsPer100ml.
                if let gramsValue = grams.value {
                    saved.append(PortionData(id: id, foodId: foodId, label: label, kind: row.kind, quantity: quantity ?? 0,
                                             grams: gramsValue, carbsG: nil))
                }
            } else {
                saved.append(PortionData(id: id, foodId: foodId, label: label, kind: row.kind, quantity: quantity ?? 0,
                                         grams: grams.value, carbsG: carbs.value))
            }
        }
        // Fresh (this-edit) sources implying different carbsPer100ml (any pair of: the label entry and
        // each volume portion row) block save instead of one silently overwriting another; when all
        // agree, the label entry wins if present, else the first row (a differing already-*saved*
        // value is instead surfaced non-blockingly via `portionVolumeCarbsNote`).
        switch Self.resolveVolume(mlCandidates) {
        case .failure(let error): problems.append(error.message)
        case .success(let value): if let value { carbsPer100ml = value }
        }

        let hasBasis = isValidCarbsPer100g(carbsPer100g) || isValidCarbsPer100ml(carbsPer100ml)
            || saved.contains { $0.kind != "volume" && isValidPortionCarbs($0.carbsG) }
        if !hasBasis { problems.append("Enter carbs: per 100 g, per cup/etc., or for a piece.") }

        guard problems.isEmpty else { return .failure(FoodFormErrors(messages: problems)) }

        let food = FoodData(
            id: foodId, name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            brand: Self.blank(brand) ? nil : brand.trimmingCharacters(in: .whitespacesAndNewlines),
            source: copy ? "custom" : (base?.source ?? "custom"),
            sourceRef: copy ? nil : base?.sourceRef,
            derivedFrom: copy ? base?.id : base?.derivedFrom,
            carbsPer100g: carbsPer100g, carbsPer100ml: carbsPer100ml, fiberPer100g: fiberValue, densityGPerMl: densityValue,
            notes: Self.blank(notes) ? nil : notes)
        let kept = Set(saved.map(\.id))
        let removed = copy ? [] : basePortionIds.filter { !kept.contains($0) }
        return .success(Output(food: food, portions: saved, removedPortionIds: removed))
    }
}

public struct FoodFormErrors: Error, Equatable, Sendable {
    public var messages: [String]
}
