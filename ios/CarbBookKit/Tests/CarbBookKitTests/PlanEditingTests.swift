import CarbBookCore
@testable import CarbBookKit
import Foundation
import XCTest

final class PlanEditingTests: XCTestCase {
    /// Rice: 28.2 g carbs per 100 g. Bread: no carb data at all, so it is incomplete.
    let catalog = InMemoryCatalog(
        foods: [
            FoodData(id: "rice", name: "Rice", source: "custom", carbsPer100g: 28.2),
            FoodData(id: "bread", name: "Mystery bread", source: "custom", carbsPer100g: nil),
        ],
        portions: [], meals: [], mealItems: [])

    /// Deterministic ids so the expected records can be written out in full.
    func idFactory() -> () -> Id {
        var counter = 0
        return { counter += 1; return "new\(counter)" }
    }

    func testSlotCarbsSumTheItems() {
        let items = [
            PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
            PlanItemData(id: "i2", planEntryId: "p1", refType: .food, refId: "rice", amount: 50, unit: "g", position: 1),
        ]
        let total = PlanEditing.carbs(items, catalog: catalog)
        XCTAssertTrue(total.complete)
        XCTAssertEqual(total.carbsG, 42.3, accuracy: 0.001)
    }

    func testAnItemWithoutCarbDataMakesTheSlotIncomplete() {
        let items = [
            PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "rice", amount: 100, unit: "g", position: 0),
            PlanItemData(id: "i2", planEntryId: "p1", refType: .food, refId: "bread", amount: 50, unit: "g", position: 1),
        ]
        XCTAssertFalse(PlanEditing.carbs(items, catalog: catalog).complete)
    }

    func testAnEmptySlotIsCompleteAndZero() {
        XCTAssertEqual(PlanEditing.carbs([], catalog: catalog), CarbResult(carbsG: 0, complete: true))
    }

    func testSaveChangesCreateAnEntryAndRenumberItsItems() throws {
        let newId = idFactory()
        let draft = PlanEditing.Draft(
            date: "2026-09-16", windowName: "Lunch", note: "  ",
            items: [
                PlanEditing.DraftItem(id: nil, refType: .food, refId: "rice", amount: 0.5, unit: "cup"),
                PlanEditing.DraftItem(id: nil, refType: .meal, refId: "m1", amount: 1, unit: Units.serving),
            ])
        let changes = try PlanEditing.saveChanges(draft: draft, existing: nil, existingItems: [], newId: newId)
        XCTAssertEqual(changes.map(\.table), ["plan_entry", "plan_item", "plan_item"])
        XCTAssertEqual(changes[0].record["status"], .string("planned"))
        XCTAssertEqual(changes[0].record["note"], .null, "blank note is stored as null, not as spaces")
        XCTAssertEqual(changes[1].record["plan_entry_id"], .string("new1"))
        XCTAssertEqual(changes[1].record["position"], .number(0))
        XCTAssertEqual(changes[2].record["position"], .number(1))
    }

    func testSaveChangesKeepStatusAndLinkOfAnExistingSlot() throws {
        let existing = PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .logged,
                                     note: "old", logEntryId: "l1")
        let draft = PlanEditing.Draft(date: "2026-09-16", windowName: "Lunch", note: "new",
                                      items: [PlanEditing.DraftItem(id: "i1", refType: .food, refId: "rice",
                                                                    amount: 100, unit: "g")])
        let changes = try PlanEditing.saveChanges(draft: draft, existing: existing,
                                                  existingItems: [
                                                      PlanItemData(id: "i1", planEntryId: "p1", refType: .food,
                                                                   refId: "rice", amount: 50, unit: "g", position: 0)],
                                                  newId: idFactory())
        XCTAssertEqual(changes[0].record["id"], .string("p1"))
        XCTAssertEqual(changes[0].record["status"], .string("logged"))
        XCTAssertEqual(changes[0].record["log_entry_id"], .string("l1"))
        XCTAssertEqual(changes[0].record["note"], .string("new"))
        XCTAssertEqual(changes[1].record["id"], .string("i1"), "an edited row keeps its id")
        XCTAssertEqual(changes[1].record["amount"], .number(100))
    }

    func testRemovedItemsAreSoftDeleted() throws {
        let existing = PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .planned)
        let draft = PlanEditing.Draft(date: "2026-09-16", windowName: "Lunch", note: nil, items: [])
        let changes = try PlanEditing.saveChanges(
            draft: draft, existing: existing,
            existingItems: [PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "rice",
                                         amount: 50, unit: "g", position: 0)],
            newId: idFactory())
        XCTAssertEqual(changes.count, 2)
        XCTAssertEqual(changes[1].record["id"], .string("i1"))
        XCTAssertEqual(changes[1].record["deleted"], .number(1))
    }

    func testAnInvalidAmountRefusesToSave() {
        let draft = PlanEditing.Draft(date: "2026-09-16", windowName: "Lunch", note: nil,
                                      items: [PlanEditing.DraftItem(id: nil, refType: .food, refId: "rice",
                                                                    amount: .nan, unit: "g")])
        XCTAssertThrowsError(try PlanEditing.saveChanges(draft: draft, existing: nil, existingItems: [],
                                                         newId: idFactory())) { error in
            XCTAssertEqual(error as? PlanEditing.EditError, .invalidAmount)
        }
    }

    func testDeleteChangesSoftDeleteTheSlotAndItsItems() {
        let changes = PlanEditing.deleteChanges(
            entry: PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .planned),
            items: [PlanItemData(id: "i1", planEntryId: "p1", refType: .food, refId: "rice",
                                 amount: 50, unit: "g", position: 0)])
        XCTAssertEqual(changes.map(\.table), ["plan_entry", "plan_item"])
        XCTAssertTrue(changes.allSatisfy { $0.record["deleted"] == .number(1) })
    }

    func testStatusChangeKeepsEverythingElse() {
        let entry = PlanEntryData(id: "p1", date: "2026-09-16", windowName: "Lunch", status: .planned, note: "x")
        let change = PlanEditing.statusChange(entry, to: .skipped)
        XCTAssertEqual(change.record["status"], .string("skipped"))
        XCTAssertEqual(change.record["note"], .string("x"))
        XCTAssertEqual(change.record["log_entry_id"], .null)
    }

    func testSaveChangesTrimsANewWindowName() throws {
        let draft = PlanEditing.Draft(date: "2026-09-16", windowName: "  Lunch  ", note: nil, items: [])
        let changes = try PlanEditing.saveChanges(draft: draft, existing: nil, existingItems: [], newId: idFactory())
        XCTAssertEqual(changes[0].record["window_name"], .string("Lunch"))
    }
}
