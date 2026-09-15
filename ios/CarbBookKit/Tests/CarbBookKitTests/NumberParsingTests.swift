@testable import CarbBookKit
import Foundation
import XCTest

final class NumberParsingTests: XCTestCase {
    func testParseAmountAcceptsPlainDecimalsAndACommaSeparator() {
        XCTAssertEqual(NumberParsing.parseAmount("28.2"), 28.2)
        XCTAssertEqual(NumberParsing.parseAmount("28,2"), 28.2)
        XCTAssertEqual(NumberParsing.parseAmount("0"), 0)
        XCTAssertEqual(NumberParsing.parseAmount("100"), 100)
        XCTAssertEqual(NumberParsing.parseAmount("  4.5  "), 4.5)
    }

    func testParseAmountRejectsEmptyHexExponentInfinityAndNegatives() {
        XCTAssertNil(NumberParsing.parseAmount(""))
        XCTAssertNil(NumberParsing.parseAmount("   "))
        XCTAssertNil(NumberParsing.parseAmount("0x10"))
        XCTAssertNil(NumberParsing.parseAmount("1e5"))
        XCTAssertNil(NumberParsing.parseAmount("1E5"))
        XCTAssertNil(NumberParsing.parseAmount("Infinity"))
        XCTAssertNil(NumberParsing.parseAmount("inf"))
        XCTAssertNil(NumberParsing.parseAmount("NaN"))
        XCTAssertNil(NumberParsing.parseAmount("-5"))
        XCTAssertNil(NumberParsing.parseAmount("5."))
        XCTAssertNil(NumberParsing.parseAmount("5,2.1"))
        XCTAssertNil(NumberParsing.parseAmount("abc"))
        XCTAssertNil(NumberParsing.parseAmount("5 g"))
    }

    func testParseWholeNumberRejectsDecimalsAndCommas() {
        XCTAssertEqual(NumberParsing.parseWholeNumber("120"), 120)
        XCTAssertEqual(NumberParsing.parseWholeNumber(" 85 "), 85)
        XCTAssertNil(NumberParsing.parseWholeNumber("120.5"))
        XCTAssertNil(NumberParsing.parseWholeNumber("120,5"))
        XCTAssertNil(NumberParsing.parseWholeNumber(""))
        XCTAssertNil(NumberParsing.parseWholeNumber("1e2"))
        XCTAssertNil(NumberParsing.parseWholeNumber("0x10"))
        XCTAssertNil(NumberParsing.parseWholeNumber("Infinity"))
        XCTAssertNil(NumberParsing.parseWholeNumber("-5"))
    }

    func testIsMalformedDistinguishesBlankFromInvalid() {
        XCTAssertFalse(NumberParsing.isMalformed(""))
        XCTAssertFalse(NumberParsing.isMalformed("   "))
        XCTAssertFalse(NumberParsing.isMalformed("12.5"))
        XCTAssertTrue(NumberParsing.isMalformed("12.5.6"))
        XCTAssertTrue(NumberParsing.isMalformed("abc"))
        XCTAssertTrue(NumberParsing.isMalformed("1e5"))
        XCTAssertFalse(NumberParsing.isMalformed("120", using: NumberParsing.parseWholeNumber))
        XCTAssertTrue(NumberParsing.isMalformed("120.5", using: NumberParsing.parseWholeNumber))
    }

    /// Text-field prefills (Log entry, Dose settings, barcode draft) use `editText`: plain digits, "."
    /// decimal, never locale grouping, and it parses back strictly to the same value.
    func testEditTextIsPlainForPrefills() {
        XCTAssertEqual(NumberParsing.editText(12.5), "12.5")
        XCTAssertEqual(NumberParsing.editText(1200), "1200")
        XCTAssertEqual(NumberParsing.editText(0.5), "0.5")
        XCTAssertEqual(NumberParsing.editText(130), "130")
        XCTAssertEqual(NumberParsing.editText(1234567.25, maxFractionDigits: 2), "1234567.25")
        XCTAssertEqual(NumberParsing.editText(1200, maxFractionDigits: 2), "1200")
        XCTAssertEqual(NumberParsing.editText(130.4, maxFractionDigits: 0), "130")
        for value in [12.5, 1200, 0.5, 130] {
            XCTAssertEqual(NumberParsing.parseAmount(NumberParsing.editText(value)), value)
        }
        XCTAssertEqual(NumberParsing.parseWholeNumber(NumberParsing.editText(130, maxFractionDigits: 0)), 130)
    }

    func testParseAmountAcceptsFractions() {
        XCTAssertEqual(NumberParsing.parseAmount("1/3"), 1.0 / 3.0)
        XCTAssertEqual(NumberParsing.parseAmount("2/3"), 2.0 / 3.0)
        XCTAssertEqual(NumberParsing.parseAmount("1 1/2"), 1.5)
        XCTAssertEqual(NumberParsing.parseAmount("2 2/3"), 2.0 + 2.0 / 3.0)
        XCTAssertEqual(NumberParsing.parseAmount("½"), 0.5)
        XCTAssertEqual(NumberParsing.parseAmount("⅔"), 2.0 / 3.0)
        XCTAssertEqual(NumberParsing.parseAmount("1½"), 1.5)
        XCTAssertEqual(NumberParsing.parseAmount("1 ½"), 1.5)
        XCTAssertEqual(NumberParsing.parseAmount("2⅔"), 2.0 + 2.0 / 3.0)
        XCTAssertEqual(NumberParsing.parseAmount(".5"), 0.5)
    }

    func testParseAmountRejectsMalformedFractions() {
        for text in ["-1", "1/0", "0/0", "/3", "1/", "1//3", "3/2/1", "1/-3", "1.5/2", "1 1", "1 1/0", "½½"] {
            XCTAssertNil(NumberParsing.parseAmount(text), text)
        }
    }

    /// A 2+-digit numerator greater than its denominator ("11/2") is a likely mistyped mixed number
    /// ("1 1/2") that would otherwise silently read as 5.5 — a 3.7× overdose. A mixed number's own
    /// fraction part must be < 1 ("1 3/2" makes no sense as a mixed number). Single-digit numerators
    /// and numerators not greater than the denominator are unaffected.
    func testParseAmountRejectsAmbiguousFractions() {
        for text in ["11/2", "13/4", "10/3", "1 3/2", "2 4/4"] {
            XCTAssertNil(NumberParsing.parseAmount(text), text)
        }
        XCTAssertEqual(NumberParsing.parseAmount("4/3"), 4.0 / 3.0)
        XCTAssertEqual(NumberParsing.parseAmount("3/2"), 1.5)
        XCTAssertEqual(NumberParsing.parseAmount("12/16"), 12.0 / 16.0)
    }

    func testParseAmountRejectsNonFiniteResults() {
        XCTAssertNil(NumberParsing.parseAmount(String(repeating: "1", count: 400)))
        // Both huge enough to overflow to Double.infinity; infinity/infinity is NaN, not a number.
        XCTAssertNil(NumberParsing.parseAmount(String(repeating: "9", count: 400) + "/" + String(repeating: "9", count: 401)))
    }

    /// Runs the shared vectors in testdata/ (copied into Resources/ by scripts/sync-testdata.sh):
    /// every `amount.accept`/`amount.reject` case against `parseAmount`, every `bg` case against
    /// `parseWholeNumber`. Kept in sync with web/src/ui/format.ts.
    func testNumberParseVectors() throws {
        struct AcceptCase: Decodable { let text: String; let value: Double }
        struct Vectors: Decodable {
            struct Amount: Decodable { let accept: [AcceptCase]; let reject: [String] }
            struct Bg: Decodable { let accept: [AcceptCase]; let reject: [String] }
            let tolerance: Double
            let amount: Amount
            let bg: Bg
        }
        let url = try XCTUnwrap(Bundle.module.url(forResource: "number-parse-vectors", withExtension: "json", subdirectory: "Resources"))
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
        XCTAssertFalse(vectors.amount.accept.isEmpty)
        XCTAssertFalse(vectors.amount.reject.isEmpty)
        for c in vectors.amount.accept {
            XCTAssertEqual(try XCTUnwrap(NumberParsing.parseAmount(c.text), c.text), c.value, accuracy: vectors.tolerance, c.text)
        }
        for text in vectors.amount.reject {
            XCTAssertNil(NumberParsing.parseAmount(text), text)
        }
        for c in vectors.bg.accept {
            XCTAssertEqual(try XCTUnwrap(NumberParsing.parseWholeNumber(c.text), c.text), c.value, accuracy: vectors.tolerance, c.text)
        }
        for text in vectors.bg.reject {
            XCTAssertNil(NumberParsing.parseWholeNumber(text), text)
        }
    }
}
