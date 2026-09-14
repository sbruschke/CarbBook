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

    // Expected values from node: `(x).toFixed(d)`.
    func testToFixedExactTiesUseTheExactBinaryValue() {
        XCTAssertEqual(JS.toFixed(656489253044128.375, 2), "656489253044128.38") // nextUp would give .50
        XCTAssertEqual(JS.toFixed(1.005, 2), "1.00")
        XCTAssertEqual(JS.toFixed(2.5, 2), "2.50")
        XCTAssertEqual(JS.toFixed(2.5, 0), "3")
        XCTAssertEqual(JS.toFixed(0.125, 2), "0.13")
        XCTAssertEqual(JS.toFixed(0.125, 1), "0.1")
        XCTAssertEqual(JS.toFixed(8.345, 2), "8.35")
        XCTAssertEqual(JS.toFixed(1.45, 1), "1.4")
        XCTAssertEqual(JS.toFixed(0.5, 0), "1")
        XCTAssertEqual(JS.toFixed(-0.5, 0), "-1")
        XCTAssertEqual(JS.toFixed(9.995, 2), "9.99")
        XCTAssertEqual(JS.toFixed(99.5, 0), "100")
    }

    func testToFixedExtremesMatchJavaScript() {
        XCTAssertEqual(JS.toFixed(1e21, 2), "1e+21")
        XCTAssertEqual(JS.toFixed(-1e21, 2), "-1e+21")
        XCTAssertEqual(JS.toFixed(1e25, 2), "1e+25")
        XCTAssertEqual(JS.toFixed(.infinity, 2), "Infinity")
        XCTAssertEqual(JS.toFixed(-.infinity, 2), "-Infinity")
        XCTAssertEqual(JS.toFixed(.nan, 2), "NaN")
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
