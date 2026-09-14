import Foundation

/// Turns user input into an FTS5 prefix query: `pea but` → `"pea"* "but"*` (server search.ts).
public func toFtsQuery(_ input: String) -> String? {
    var tokens: [String] = []
    var current = String.UnicodeScalarView()
    func flush() {
        if !current.isEmpty {
            tokens.append(String(current))
            current = String.UnicodeScalarView()
        }
    }
    for scalar in input.lowercased().unicodeScalars {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber:
            current.append(scalar)
        default:
            flush()
        }
    }
    flush()
    guard !tokens.isEmpty else { return nil }
    return tokens.prefix(8).map { "\"\($0)\"*" }.joined(separator: " ")
}

/// UPC-A/EAN-13 variants so "737628064502" finds a stored "0737628064502" and vice versa (server normalize.ts).
public func barcodeCandidates(_ code: String) -> [String] {
    let withoutZeros = String(code.drop(while: { $0 == "0" }))
    let stripped = withoutZeros.isEmpty ? "0" : withoutZeros
    func pad(_ s: String, _ length: Int) -> String {
        s.count >= length ? s : String(repeating: "0", count: length - s.count) + s
    }
    var seen = Set<String>()
    return [code, stripped, pad(stripped, 12), pad(stripped, 13)].filter { seen.insert($0).inserted }
}
