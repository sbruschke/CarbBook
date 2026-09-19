@testable import CarbBookKit
import XCTest

/// The downscale rule for a photo upload. Only the arithmetic is testable here: the UIKit re-encode
/// that uses it lives in the app target and cannot compile on Linux.
final class PhotoScaleTests: XCTestCase {
    func testLongestEdgeIsCappedAtTheServersMaxEdge() {
        let size = PhotoScale.targetSize(width: 2400, height: 1200)
        XCTAssertEqual(size.width, 800)
        XCTAssertEqual(size.height, 400)
    }

    func testPortraitPhotoIsCappedOnItsHeight() {
        let size = PhotoScale.targetSize(width: 3024, height: 4032)
        XCTAssertEqual(size.height, 800)
        XCTAssertEqual(size.width, 600)
    }

    /// A small image gains nothing from upscaling and only costs bytes.
    func testSmallImageIsNotUpscaled() {
        let size = PhotoScale.targetSize(width: 120, height: 90)
        XCTAssertEqual(size.width, 120)
        XCTAssertEqual(size.height, 90)
    }

    /// An extreme panorama must still round to at least one pixel, so the renderer has a valid size.
    func testVeryWideImageKeepsAtLeastOnePixelOfHeight() {
        let size = PhotoScale.targetSize(width: 20_000, height: 8)
        XCTAssertEqual(size.width, 800)
        XCTAssertEqual(size.height, 1)
    }

    func testZeroSizedImageIsNeverDividedByZero() {
        let size = PhotoScale.targetSize(width: 0, height: 0)
        XCTAssertEqual(size.width, 1)
        XCTAssertEqual(size.height, 1)
    }
}
