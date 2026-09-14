import XCTest
@testable import CarbBookCore

final class SearchHelpersTests: XCTestCase {
    func testToFtsQuery() {
        XCTAssertEqual(toFtsQuery("pea but"), #""pea"* "but"*"#)
        XCTAssertEqual(toFtsQuery("Crème Brûlée!"), #""crème"* "brûlée"*"#)
        XCTAssertEqual(toFtsQuery("  !! "), nil)
        XCTAssertEqual(toFtsQuery("a b c d e f g h i j"), #""a"* "b"* "c"* "d"* "e"* "f"* "g"* "h"*"#)
        XCTAssertEqual(toFtsQuery("2% milk"), #""2"* "milk"*"#)
    }

    func testBarcodeCandidates() {
        XCTAssertEqual(barcodeCandidates("737628064502"), ["737628064502", "0737628064502"])
        XCTAssertEqual(barcodeCandidates("0737628064502"), ["0737628064502", "737628064502"])
        XCTAssertEqual(barcodeCandidates("000000"), ["000000", "0", "000000000000", "0000000000000"])
    }
}
