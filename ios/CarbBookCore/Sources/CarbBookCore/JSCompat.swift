import Foundation

/// Helpers that reproduce JavaScript semantics the TypeScript core relies on, so both
/// implementations produce identical strings and identical tie-breaks.
public enum JS {
    /// JS `a < b` on strings: lexicographic order of UTF-16 code units (Swift's `<` compares
    /// Unicode scalars / canonical equivalence and disagrees for astral characters).
    public static func less(_ a: String, _ b: String) -> Bool {
        Array(a.utf16).lexicographicallyPrecedes(Array(b.utf16))
    }

    /// JS `a > b` on strings.
    public static func greater(_ a: String, _ b: String) -> Bool {
        less(b, a)
    }

    /// `Number.prototype.toFixed(digits)` for digits 0...20 (JS throws a RangeError outside that).
    /// Non-finite values and |x| ≥ 1e21 return `String(x)`, as JS does. Otherwise rounds the exact
    /// binary value: an exact tie picks the larger magnitude (printf would round ties to even).
    public static func toFixed(_ x: Double, _ digits: Int) -> String {
        precondition((0...20).contains(digits), "toFixed digits must be 0...20")
        if !x.isFinite || abs(x) >= 1e21 { return numberString(x) }
        if x < 0 { return "-" + toFixed(-x, digits) }
        let value = x == 0 ? 0.0 : x // drops the sign of -0, as JS does
        // A finite double m·2^e has at most max(0, 52 - e) fractional decimal digits, so this
        // precision prints its exact expansion (glibc and Apple libc print exact digits).
        let exactDigits = value == 0 ? 0 : max(0, 52 - Int(value.exponent))
        let long = String(format: "%.\(max(digits + 1, exactDigits))f", value)
        let point = long.firstIndex(of: ".")!
        var kept = Array(long[..<point].utf8) + Array(long[long.index(after: point)...].utf8.prefix(digits))
        // The first dropped digit alone decides: < 5 is below half, ≥ 5 is a tie or above (round up).
        let firstDropped = long.utf8[long.utf8.index(point, offsetBy: digits + 1)]
        if firstDropped >= UInt8(ascii: "5") {
            var i = kept.count - 1
            while i >= 0 && kept[i] == UInt8(ascii: "9") { kept[i] = UInt8(ascii: "0"); i -= 1 }
            if i >= 0 { kept[i] += 1 } else { kept.insert(UInt8(ascii: "1"), at: 0) }
        }
        let text = String(decoding: kept, as: UTF8.self)
        guard digits > 0 else { return text }
        let split = text.index(text.endIndex, offsetBy: -digits)
        return text[..<split] + "." + text[split...]
    }

    /// `String(n)` for a JS number: shortest round-trip digits, no trailing ".0",
    /// exponent notation only outside 1e-7 < |x| < 1e21.
    public static func numberString(_ x: Double) -> String {
        if x.isNaN { return "NaN" }
        if x.isInfinite { return x < 0 ? "-Infinity" : "Infinity" }
        if x == 0 { return "0" }
        if x < 0 { return "-" + numberString(-x) }
        // Swift's description is also shortest round-trip; only its layout differs.
        let description = x.description // "12.5", "1e-05", "1.5e+16"
        var mantissa = description
        var exponent = 0
        if let e = description.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = String(description[..<e])
            exponent = Int(description[description.index(after: e)...])!
        }
        let parts = mantissa.split(separator: ".", omittingEmptySubsequences: false)
        let intPart = String(parts[0])
        var fracPart = parts.count > 1 ? String(parts[1]) : ""
        while fracPart.hasSuffix("0") { fracPart.removeLast() }
        var digits = intPart + fracPart
        var pointIndex = intPart.count + exponent // position of the decimal point within digits
        while digits.hasPrefix("0") && digits.count > 1 {
            digits.removeFirst()
            pointIndex -= 1
        }
        // JS: n = pointIndex, k = digits.count
        let k = digits.count
        let n = pointIndex
        if k <= n && n <= 21 {
            return digits + String(repeating: "0", count: n - k)
        }
        if 0 < n && n <= 21 {
            let i = digits.index(digits.startIndex, offsetBy: n)
            return String(digits[..<i]) + "." + String(digits[i...])
        }
        if -6 < n && n <= 0 {
            return "0." + String(repeating: "0", count: -n) + digits
        }
        let e = n - 1
        let sign = e < 0 ? "-" : "+"
        let head = String(digits.prefix(1))
        let rest = String(digits.dropFirst())
        return (rest.isEmpty ? head : head + "." + rest) + "e" + sign + String(abs(e))
    }
}
