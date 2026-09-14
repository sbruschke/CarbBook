import XCTest
@testable import CarbBookCore

final class SmokeTests: XCTestCase {
    func testVersion() {
        XCTAssertEqual(CarbBookCore.version, "0.1.0")
    }
}
