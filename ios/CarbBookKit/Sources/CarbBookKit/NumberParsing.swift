import Foundation

/// Strict, locale-independent number parsing for every text field in the app (dose math, food
/// carbs/fiber, BG, portions, dose settings): input that isn't a plain decimal number must never be
/// silently treated as 0 or as "empty" — it has to surface as a validation error, or (for BG) reach
/// core's `invalid_input` refusal. Kept here, outside the UI target, so it can be unit tested on Linux.
public enum NumberParsing {
    private static let decimalPattern = "^([0-9]+(\\.[0-9]+)?|\\.[0-9]+)$"
    private static let digitsPattern = "^[0-9]+$"
    private static let wholeNumberPattern = "^[0-9]+$"

    /// Unicode vulgar-fraction glyphs accepted alone or right after a whole number (with or without a
    /// space): "1½" and "1 ½" both mean 1.5. Shared with testdata/number-parse-vectors.json.
    private static let unicodeFractions: [Character: (Double, Double)] = [
        "½": (1, 2), "⅓": (1, 3), "⅔": (2, 3), "¼": (1, 4), "¾": (3, 4), "⅛": (1, 8),
    ]

    /// Amount fields (carbs, fiber, grams, quantities, servings, ratios, thresholds, portion
    /// quantities…): non-negative decimal digits, with an optional fractional part after "." (or
    /// leading, as in ".5") or a single "," decimal separator (comma is accepted only here, not for
    /// `parseWholeNumber`); or a fraction — "1/3", a mixed number "1 1/2", or a single Unicode vulgar
    /// fraction glyph alone or after a whole number ("1½", "1 ½"). Trimmed first; empty, exponents
    /// ("1e5"), hex ("0x10"), "Infinity"/"NaN", negative numbers, and malformed fractions (zero or
    /// negative denominators, extra slashes, decimals inside a fraction, more than one Unicode glyph)
    /// all fail to parse (return nil), never becoming 0.
    public static func parseAmount(_ text: String) -> Double? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let glyphCount = trimmed.filter { unicodeFractions[$0] != nil }.count
        if glyphCount > 0 {
            guard glyphCount == 1, let last = trimmed.last, let fraction = unicodeFractions[last] else { return nil }
            let prefix = String(trimmed.dropLast()).trimmingCharacters(in: .whitespaces)
            let whole: Double
            if prefix.isEmpty {
                whole = 0
            } else {
                guard prefix.range(of: digitsPattern, options: .regularExpression) != nil, let w = Double(prefix) else { return nil }
                whole = w
            }
            return whole + fraction.0 / fraction.1
        }

        let parts = trimmed.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        switch parts.count {
        case 1:
            return parseToken(parts[0])
        case 2:
            guard parts[0].range(of: digitsPattern, options: .regularExpression) != nil, let whole = Double(parts[0]) else { return nil }
            guard let fraction = parseFraction(parts[1]) else { return nil }
            return whole + fraction
        default:
            return nil
        }
    }

    /// A single space-free token: an ASCII fraction ("n/d") if it contains "/", else a plain decimal.
    private static func parseToken(_ token: String) -> Double? {
        if token.contains("/") { return parseFraction(token) }
        let normalized = token.replacingOccurrences(of: ",", with: ".")
        guard normalized.range(of: decimalPattern, options: .regularExpression) != nil else { return nil }
        return Double(normalized)
    }

    /// "n/d" with non-negative integer numerator and denominator (no sign, no decimal, no extra
    /// slashes) and a non-zero denominator.
    private static func parseFraction(_ token: String) -> Double? {
        let comps = token.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard comps.count == 2 else { return nil }
        guard comps[0].range(of: digitsPattern, options: .regularExpression) != nil,
              comps[1].range(of: digitsPattern, options: .regularExpression) != nil,
              let numerator = Double(comps[0]), let denominator = Double(comps[1]), denominator != 0
        else { return nil }
        return numerator / denominator
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
