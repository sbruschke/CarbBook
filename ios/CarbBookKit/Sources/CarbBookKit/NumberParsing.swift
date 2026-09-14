import Foundation

/// Strict, locale-independent number parsing for every text field in the app (dose math, food
/// carbs/fiber, BG, portions, dose settings): input that isn't a plain decimal number must never be
/// silently treated as 0 or as "empty" — it has to surface as a validation error, or (for BG) reach
/// core's `invalid_input` refusal. Kept here, outside the UI target, so it can be unit tested on Linux.
public enum NumberParsing {
    private static let amountPattern = "^[0-9]+(\\.[0-9]+)?$"
    private static let wholeNumberPattern = "^[0-9]+$"

    /// Amount fields (carbs, fiber, grams, quantities, servings, ratios, thresholds…): non-negative
    /// decimal digits, with an optional fractional part after "." or a single "," (comma is accepted
    /// only here, not for `parseWholeNumber`). Trimmed first; empty, exponents ("1e5"), hex ("0x10"),
    /// "Infinity"/"NaN" and negative numbers all fail to parse (return nil), never becoming 0.
    public static func parseAmount(_ text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let normalized = trimmed.replacingOccurrences(of: ",", with: ".")
        guard normalized.range(of: amountPattern, options: .regularExpression) != nil else { return nil }
        return Double(normalized)
    }

    /// Whole-number-only fields (BG): non-negative decimal digits, no "." or ",". Trimmed first;
    /// empty, fractional, exponent, hex and "Infinity"/"NaN" spellings all fail to parse.
    public static func parseWholeNumber(_ text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.range(of: wholeNumberPattern, options: .regularExpression) != nil else { return nil }
        return Double(trimmed)
    }

    /// A stored number as editable text that `parseAmount` reads back as the same value: plain
    /// digits, "." decimal, no grouping, no exponent, trailing zeros trimmed. Locale-formatted text
    /// must not be put in an amount field: "1,000" would parse back as 1 (comma = decimal separator).
    /// nil → "". Negative or non-finite values are rendered as-is so they fail validation visibly.
    public static func editText(_ value: Double?, maxFractionDigits: Int = 10) -> String {
        guard let value else { return "" }
        guard value.isFinite else { return String(value) }
        var text = String(format: "%.\(maxFractionDigits)f", value)
        if text.contains(".") {
            while text.hasSuffix("0") { text.removeLast() }
            if text.hasSuffix(".") { text.removeLast() }
        }
        return text == "-0" ? "0" : text
    }

    /// True when the field was typed in (non-empty after trimming) but doesn't parse under `parser`.
    /// Distinguishes "the user left this blank" from "the user typed something invalid" so the latter
    /// can be surfaced as an error instead of silently behaving like the former.
    public static func isMalformed(_ text: String, using parser: (String) -> Double? = parseAmount) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && parser(text) == nil
    }
}
