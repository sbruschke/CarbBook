@testable import CarbBookKit
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
        XCTAssertNil(NumberParsing.parseAmount(".5"))
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
}
