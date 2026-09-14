import CarbBookCore
@testable import CarbBookKit
import Foundation
import XCTest

final class UsdaLibraryTests: XCTestCase {
    func testLibrarySearchesWithFTS5AndReadsPortions() throws {
        let path = try temporaryDirectory().appendingPathComponent("usda.sqlite").path
        try makeUsdaBundle(at: path, version: "v1")
        let library = try UsdaLibrary(path: path)
        XCTAssertEqual(library.version, "v1")
        XCTAssertEqual(try library.search("rice cook", limit: 5).map(\.id), ["usda:168878"])
        XCTAssertEqual(try library.search("creme", limit: 5).map(\.name), ["Crème fraîche"]) // remove_diacritics 2
        XCTAssertEqual(try library.portions(fdcId: 168878).map(\.label), ["cup", "serving"])
        XCTAssertEqual(try library.search("rice", limit: 5).first?.usdaFdcId, 168878)
    }

    func testAdoptingAUsdaFoodCopiesItOnce() throws {
        let path = try temporaryDirectory().appendingPathComponent("usda.sqlite").path
        try makeUsdaBundle(at: path, version: "v1")
        let library = try UsdaLibrary(path: path)
        let store = try LocalStore(path: nil, now: { 1_000 })
        let id = try store.adoptUsdaFood(fdcId: 168878, library: library)
        // Deterministic ids shared with the web client, so devices copying offline converge.
        XCTAssertEqual(id, "usda-168878")
        XCTAssertEqual(try store.adoptUsdaFood(fdcId: 168878, library: library), id)
        let food = try XCTUnwrap(try store.catalog().food(id))
        XCTAssertEqual(food.source, "usda")
        XCTAssertEqual(food.sourceRef, "168878")
        XCTAssertEqual(try store.portions(foodId: id).map(\.label), ["serving", "cup"]) // ordered by grams
        XCTAssertEqual(try store.portions(foodId: id).map(\.id), ["usda-portion-2", "usda-portion-1"])
        XCTAssertEqual(try store.pendingCount(), 3)
        XCTAssertEqual(try store.search("rice", limit: 5, usda: library).map(\.kind), [.food, .usda])
        XCTAssertThrowsError(try store.adoptUsdaFood(fdcId: 1, library: library))
    }
}
