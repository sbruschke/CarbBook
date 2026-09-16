import CarbBookCore
@testable import CarbBookKit
import Foundation
import XCTest

final class PlanSuggestionTests: XCTestCase {
    let catalog = InMemoryCatalog(
        foods: [FoodData(id: "rice", name: "Rice", source: "custom", carbsPer100g: 28.2)],
        portions: [], meals: [], mealItems: [])

    private func slot(_ status: PlanStatus) -> PlanEntryData {
        PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: status)
    }

    private var items: [PlanItemData] {
        [PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0)]
    }

    func testAPlannedSlotIsSuggested() {
        let suggestion = PlanSuggestion.make(entry: slot(.planned), items: items, catalog: catalog, dismissed: [])
        XCTAssertNotNil(suggestion)
        XCTAssertEqual(suggestion?.entryId, "p1")
        XCTAssertEqual(suggestion?.carbs.carbsG ?? 0, 28.2, accuracy: 0.001)
        XCTAssertEqual(suggestion?.itemNames, ["Rice"])
    }

    func testLoggedSkippedEmptyAndDismissedSlotsAreNotSuggested() {
        XCTAssertNil(PlanSuggestion.make(entry: slot(.logged), items: items, catalog: catalog, dismissed: []))
        XCTAssertNil(PlanSuggestion.make(entry: slot(.skipped), items: items, catalog: catalog, dismissed: []))
        XCTAssertNil(PlanSuggestion.make(entry: slot(.planned), items: [], catalog: catalog, dismissed: []))
        XCTAssertNil(PlanSuggestion.make(entry: nil, items: [], catalog: catalog, dismissed: []))
        XCTAssertNil(PlanSuggestion.make(entry: slot(.planned), items: items, catalog: catalog,
                                         dismissed: ["2026-09-16|lunch"]))
    }

    func testAnItemWhoseFoodHasNotSyncedYetStillSuggestsWithMissingData() {
        let unknown = [PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "ghost",
                                    amount: 1, unit: "g", position: 0)]
        let suggestion = PlanSuggestion.make(entry: slot(.planned), items: unknown, catalog: catalog, dismissed: [])
        XCTAssertEqual(suggestion?.itemNames, ["Unknown item"])
        XCTAssertEqual(suggestion?.carbs.complete, false)
    }

    func testLoadProducesEditableCalculatorLines() {
        let suggestion = PlanSuggestion.make(entry: slot(.planned), items: items, catalog: catalog, dismissed: [])
        let lines = PlanSuggestion.lines(for: items, catalog: catalog, newLineId: { "line1" })
        XCTAssertEqual(suggestion?.entryId, "p1")
        XCTAssertEqual(lines, [CalculatorLine(id: "line1", refType: .food, refId: "rice",
                                              displayName: "Rice", amount: 100, unit: "g")])
    }

    func testDismissalsPersistPerDeviceAndAreKeyedByDateAndWindow() throws {
        let name = "plan-suggestion-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        XCTAssertTrue(PlanDismissals.load(from: defaults).isEmpty)
        PlanDismissals.dismiss(date: "2026-09-16", windowName: "Lunch", in: defaults)
        XCTAssertEqual(PlanDismissals.load(from: defaults), ["2026-09-16|lunch"])
        PlanDismissals.dismiss(date: "2026-09-16", windowName: "Dinner", in: defaults)
        XCTAssertEqual(PlanDismissals.load(from: defaults), ["2026-09-16|lunch", "2026-09-16|dinner"])
    }

    func testDismissalsNormalizeCaseAndWhitespace() throws {
        let name = "plan-suggestion-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        PlanDismissals.dismiss(date: "2026-09-16", windowName: "  LUNCH  ", in: defaults)
        XCTAssertEqual(PlanDismissals.load(from: defaults), ["2026-09-16|lunch"])
        // Dismissing "Lunch" again is a no-op: it is the same slot identity.
        PlanDismissals.dismiss(date: "2026-09-16", windowName: "Lunch", in: defaults)
        XCTAssertEqual(PlanDismissals.load(from: defaults), ["2026-09-16|lunch"])
    }

    func testShownHidesTheSuggestionOnceASlotIsLoaded() {
        let computed = PlanSuggestion.make(entry: slot(.planned), items: items, catalog: catalog, dismissed: [])
        XCTAssertNotNil(computed)
        XCTAssertEqual(PlanSuggestion.shown(computed: computed, loadedSlotId: nil), computed,
                       "no slot loaded yet: the computed suggestion is shown as-is")
        XCTAssertNil(PlanSuggestion.shown(computed: computed, loadedSlotId: "p1"),
                    "a slot is loaded: never re-show a suggestion, even a freshly computed one")
        XCTAssertNil(PlanSuggestion.shown(computed: computed, loadedSlotId: "some-other-slot"),
                    "any loaded slot suppresses suggestions, not only the matching one")
        XCTAssertNil(PlanSuggestion.shown(computed: nil, loadedSlotId: nil))
    }

    func testCorruptDismissalStorageIsTreatedAsEmpty() throws {
        let name = "plan-suggestion-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("not a list", forKey: PlanDismissals.key)
        XCTAssertTrue(PlanDismissals.load(from: defaults).isEmpty)
        PlanDismissals.dismiss(date: "2026-09-16", windowName: "Lunch", in: defaults)
        XCTAssertEqual(PlanDismissals.load(from: defaults), ["2026-09-16|lunch"])
    }
}
