import Foundation

/// Strict, locale-independent number parsing for every text field in the app (dose math, food
/// carbs/fiber, BG, portions, dose settings): input that isn't a plain decimal number must never be
/// silently treated as 0 or as "empty" — it has to surface as a validation error, or (for BG) reach
/// core's `invalid_input` refusal. Kept here, outside the UI target, so it can be unit tested on Linux.
/// Shared spec: testdata/number-parse-vectors.json (web: web/src/ui/format.ts).
public enum NumberParsing {
    /// Unicode vulgar-fraction glyphs accepted alone or right after a whole number (with no space or
    /// a single ASCII space): "1½" and "1 ½" both mean 1.5.
    private static let unicodeFractions: [String: (Double, Double)] = [
        "½": (1, 2), "⅓": (1, 3), "⅔": (2, 3), "¼": (1, 4), "¾": (3, 4), "⅛": (1, 8),
    ]
    private static let unicodeFractionClass = "[½⅓⅔¼¾⅛]"

    /// Capture groups of a whole-string match (unmatched optional groups are nil), or nil when the
    /// pattern doesn't match. Patterns use `[0-9]`, never `\d` (ICU `\d` matches non-ASCII digits).
    private static func match(_ pattern: String, _ text: String) -> [String?]? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let result = regex.firstMatch(in: text, range: range), result.range == range else { return nil }
        return (0..<result.numberOfRanges).map { i in
            Range(result.range(at: i), in: text).map { String(text[$0]) }
        }
    }

    private static func trim(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// "12,5" → "12.5": a single comma between digit runs is a decimal separator; anything else unchanged.
    private static func commaDecimal(_ trimmed: String) -> String {
        match("^[0-9]+,[0-9]+$", trimmed) != nil ? trimmed.replacingOccurrences(of: ",", with: ".") : trimmed
    }

    private static func finite(_ value: Double?) -> Double? {
        guard let value, value.isFinite else { return nil }
        return value
    }

    /// Non-amount fields — carbs, fiber, weights, density, ratios, correction units per step, rounding
    /// increment, taken dose, meal total weight (`decimal` vectors): digits with an optional ".digits"
    /// part, or a single "," decimal separator ("12,5"). Trimmed first. No fractions ("1/2", "½" —
    /// a fractional gram, ratio or dose is never a legitimate entry), no leading dot, no sign, no
    /// exponent/hex/"Infinity", and non-finite results (hundreds of digits) all return nil.
    public static func parseNonNegative(_ text: String) -> Double? {
        let trimmed = trim(text)
        guard !trimmed.isEmpty else { return nil }
        let normalized = commaDecimal(trimmed)
        guard match("^[0-9]+(\\.[0-9]+)?$", normalized) != nil else { return nil }
        return finite(Double(normalized))
    }

    /// Amount fields only — item amounts, meal component amounts, yield/servings, label amount,
    /// portion quantity (`amount` vectors). Accepts, after trimming:
    ///  - a plain or leading-dot decimal ("1", "1.5", ".5"), or a single comma decimal ("1,5");
    ///  - an ASCII fraction "n/d" (non-zero denominator);
    ///  - an ASCII mixed number "w n/d" with exactly one ASCII space;
    ///  - a Unicode vulgar fraction (½ ⅓ ⅔ ¼ ¾ ⅛) alone or after a whole number with no space or
    ///    exactly one ASCII space ("1½", "1 ½").
    /// Rejects everything else: negative/"+" signs, exponents, hex, "Infinity"/"NaN", malformed
    /// fractions, tabs / non-breaking / repeated spaces inside the number, ",5", non-finite results, and
    /// two ambiguous-typo shapes: a plain "n/d" whose 2+-digit numerator exceeds the denominator
    /// ("11/2" — likely a mistyped "1 1/2", a 3.7× overdose if taken literally) and a mixed number
    /// whose fraction part is ≥ 1 ("1 3/2").
    public static func parseAmount(_ text: String) -> Double? {
        finite(parseAmountUnchecked(text))
    }

    private static func parseAmountUnchecked(_ text: String) -> Double? {
        let trimmed = trim(text)
        guard !trimmed.isEmpty else { return nil }

        let decimal = commaDecimal(trimmed)
        if match("^([0-9]+\\.[0-9]+|\\.[0-9]+|[0-9]+)$", decimal) != nil { return Double(decimal) }

        if let g = match("^([0-9]+)/([0-9]+)$", trimmed), let numText = g[1], let denText = g[2],
           let num = Double(numText), let den = Double(denText) {
            guard den != 0 else { return nil }
            if numText.count >= 2 && num > den { return nil }
            return num / den
        }

        if let g = match("^([0-9]+) ([0-9]+)/([0-9]+)$", trimmed), let wholeText = g[1], let numText = g[2], let denText = g[3],
           let whole = Double(wholeText), let num = Double(numText), let den = Double(denText) {
            guard den != 0, num / den < 1 else { return nil }
            return whole + num / den
        }

        if let g = match("^([0-9]+)? ?(\(unicodeFractionClass))$", trimmed), let glyph = g[2], let fraction = unicodeFractions[glyph] {
            let whole: Double
            if let wholeText = g[1] {
                guard let w = Double(wholeText) else { return nil }
                whole = w
            } else {
                whole = 0
            }
            return whole + fraction.0 / fraction.1
        }

        return nil
    }

    /// Whole-number-only fields (BG, correction threshold/step, round-down BG): non-negative decimal
    /// digits, no "." or ",". Trimmed first; empty, fractional, exponent, hex and "Infinity"/"NaN"
    /// spellings all fail to parse.
    public static func parseWholeNumber(_ text: String) -> Double? {
        let trimmed = trim(text)
        guard !trimmed.isEmpty, match("^[0-9]+$", trimmed) != nil else { return nil }
        return finite(Double(trimmed))
    }

    /// A stored number as editable text that `parseAmount` and `parseNonNegative` read back as the
    /// same value: plain digits, "." decimal, no grouping, no exponent, trailing zeros trimmed.
    /// Locale-formatted text must not be put in a number field: "1,000" would parse back as 1 (comma
    /// = decimal separator). nil → "". Negative or non-finite values are rendered as-is so they fail
    /// validation visibly.
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
    public static func isMalformed(_ text: String, using parser: (String) -> Double?) -> Bool {
        !trim(text).isEmpty && parser(text) == nil
    }
}

/// Dose settings editor fields, parsed like web `DoseSettingsEditor.tsx`: ratio, units per step and
/// rounding increment are decimals (`parseNonNegative`); threshold, step and round-down BG are whole
/// mg/dL (`parseWholeNumber`). Malformed text becomes NaN — never a silent 0 — so the settings
/// validators (which require finite values) reject the draft.
public enum DoseSettingsInput {
    public static func decimal(_ text: String) -> Double { NumberParsing.parseNonNegative(text) ?? .nan }
    public static func mgdl(_ text: String) -> Double { NumberParsing.parseWholeNumber(text) ?? .nan }
}
