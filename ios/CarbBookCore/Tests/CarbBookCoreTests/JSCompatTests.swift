import XCTest
@testable import CarbBookCore

final class JSCompatTests: XCTestCase {
    func testStringOrderUsesUTF16CodeUnits() {
        // U+FF61 is one UTF-16 unit (0xFF61); U+1F600 is a surrogate pair starting 0xD83D.
        // JS: "｡" > "😀". Swift's own `<` says the opposite.
        XCTAssertTrue(JS.greater("\u{FF61}", "\u{1F600}"))
        XCTAssertTrue("\u{FF61}" < "\u{1F600}")
        XCTAssertTrue(JS.less("laptop", "phone"))
        XCTAssertFalse(JS.less("phone", "phone"))
        XCTAssertTrue(JS.less("a-cup", "b-cup"))
    }

    func testToFixedMatchesJavaScript() {
        XCTAssertEqual(JS.toFixed(9, 1), "9.0")
        XCTAssertEqual(JS.toFixed(9.9, 1), "9.9")
        XCTAssertEqual(JS.toFixed(2.5, 0), "3") // JS picks the larger on exact ties; printf would give "2"
        XCTAssertEqual(JS.toFixed(0.25, 1), "0.3")
        XCTAssertEqual(JS.toFixed(0.125, 2), "0.13")
        XCTAssertEqual(JS.toFixed(1.005, 2), "1.00") // 1.005 is really 1.00499999…
        XCTAssertEqual(JS.toFixed(-2.5, 0), "-3")
        XCTAssertEqual(JS.toFixed(-0.04, 1), "-0.0")
        XCTAssertEqual(JS.toFixed(10.5, 4), "10.5000")
    }

    func testNumberStringMatchesJavaScript() {
        XCTAssertEqual(JS.numberString(9), "9")
        XCTAssertEqual(JS.numberString(-0.0), "0")
        XCTAssertEqual(JS.numberString(79.2), "79.2")
        XCTAssertEqual(JS.numberString(0.1 + 0.2), "0.30000000000000004")
        XCTAssertEqual(JS.numberString(130), "130")
        XCTAssertEqual(JS.numberString(1e21), "1e+21")
        XCTAssertEqual(JS.numberString(1e16), "10000000000000000")
        XCTAssertEqual(JS.numberString(0.000001), "0.000001")
        XCTAssertEqual(JS.numberString(1.5e-7), "1.5e-7")
        XCTAssertEqual(JS.numberString(-2.25), "-2.25")
    }
}
