@testable import CarbBookKit
import XCTest

final class PermissionsTests: XCTestCase {
    func testOwnerCanEditDoseSettings() {
        XCTAssertTrue(canEditDoseSettings(role: .owner))
    }

    func testViewerCannotEditDoseSettings() {
        XCTAssertFalse(canEditDoseSettings(role: .viewer))
    }

    func testRoleParsingRecognizesOwnerExactly() {
        XCTAssertEqual(AccountRole("owner"), .owner)
        XCTAssertEqual(AccountRole("viewer"), .viewer)
    }

    func testUnknownOrMissingRoleIsTreatedAsViewer() {
        XCTAssertEqual(AccountRole(nil), .viewer)
        XCTAssertEqual(AccountRole(""), .viewer)
        XCTAssertEqual(AccountRole("Owner"), .viewer, "case must match exactly; no accidental grants from a typo'd role")
        XCTAssertFalse(canEditDoseSettings(role: AccountRole(nil)))
    }
}
