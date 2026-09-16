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

    private func item(_ id: String, _ entry: String, _ refId: String, _ position: Int) -> PlanItemData {
        PlanItemData(id: id, planEntryId: entry, refType: .food, refId: refId, amount: 1, unit: "g", position: position)
    }

    /// Source: Lunch on the 16th with one item. Target: Lunch on the 17th already has an item.
    private func copyFixture() -> (source: [PlanEntryData], target: [PlanEntryData], items: [Id: [PlanItemData]]) {
        let source = [PlanEntryData(id: "s1", date: "2026-09-16", windowName: "Lunch", status: .logged,
                                    note: "src", logEntryId: "l1")]
        let target = [PlanEntryData(id: "t1", date: "2026-09-17", windowName: "Lunch", status: .planned)]
        let items: [Id: [PlanItemData]] = ["s1": [item("si1", "s1", "rice", 0)], "t1": [item("ti1", "t1", "bread", 0)]]
        return (source, target, items)
    }

    func testCopySkipLeavesAnOccupiedSlotAlone() throws {
        let f = copyFixture()
        let changes = try PlanEditing.copyChanges(
            sourceEntries: f.source, targetEntries: f.target, itemsByEntry: f.items,
            dayOffsets: ["2026-09-16": "2026-09-17"], mode: .skip, newId: idFactory())
        XCTAssertTrue(changes.isEmpty)
    }

    func testCopyMergeAppendsItemsAfterTheExistingOnes() throws {
        let f = copyFixture()
        let changes = try PlanEditing.copyChanges(
            sourceEntries: f.source, targetEntries: f.target, itemsByEntry: f.items,
            dayOffsets: ["2026-09-16": "2026-09-17"], mode: .merge, newId: idFactory())
        XCTAssertEqual(changes.map(\.table), ["plan_item"])
        XCTAssertEqual(changes[0].record["plan_entry_id"], .string("t1"))
        XCTAssertEqual(changes[0].record["ref_id"], .string("rice"))
        XCTAssertEqual(changes[0].record["position"], .number(1), "appended after the existing item")
        XCTAssertEqual(changes[0].record["id"], .string("new1"), "a copied item is always a new row")
    }

    func testCopyReplaceDeletesTheWholeTargetSlotAndCopiesTheSourceOnesFresh() throws {
        let f = copyFixture()
        let changes = try PlanEditing.copyChanges(
            sourceEntries: f.source, targetEntries: f.target, itemsByEntry: f.items,
            dayOffsets: ["2026-09-16": "2026-09-17"], mode: .replace, newId: idFactory())
        XCTAssertEqual(changes.map(\.table), ["plan_item", "plan_entry", "plan_entry", "plan_item"])
        XCTAssertEqual(changes[0].record["id"], .string("ti1"))
        XCTAssertEqual(changes[0].record["deleted"], .number(1))
        XCTAssertEqual(changes[1].record["id"], .string("t1"))
        XCTAssertEqual(changes[1].record["deleted"], .number(1), "the whole target slot is removed, not reset in place")
        XCTAssertEqual(changes[2].record["id"], .string("new1"), "the copy is a brand new slot")
        XCTAssertEqual(changes[2].record["status"], .string("planned"))
        XCTAssertEqual(changes[2].record["log_entry_id"], .null)
        XCTAssertEqual(changes[3].record["ref_id"], .string("rice"))
        XCTAssertEqual(changes[3].record["position"], .number(0))
    }

    /// Matches the web app (web/src/plan/copy.ts): "replace" clears the WHOLE target day, not just
    /// slots whose window matches a source slot, so a stray unmatched slot is never left behind.
    func testCopyReplaceClearsUnmatchedSlotsOnTheTargetDayToo() throws {
        let source = [PlanEntryData(id: "s1", date: "2026-09-16", windowName: "Breakfast", status: .planned)]
        let target = [
            PlanEntryData(id: "t1", date: "2026-09-17", windowName: "Breakfast", status: .planned),
            PlanEntryData(id: "t2", date: "2026-09-17", windowName: "Lunch", status: .planned),
        ]
        let items: [Id: [PlanItemData]] = [
            "s1": [item("si1", "s1", "oats", 0)],
            "t1": [item("ti1", "t1", "eggs", 0)],
            "t2": [item("ti2", "t2", "soup", 0)],
        ]
        let changes = try PlanEditing.copyChanges(
            sourceEntries: source, targetEntries: target, itemsByEntry: items,
            dayOffsets: ["2026-09-16": "2026-09-17"], mode: .replace, newId: idFactory())
        let deletedEntryIds = Set(changes.filter { $0.table == "plan_entry" && $0.record["deleted"] == .number(1) }
            .compactMap { $0.record["id"] })
        XCTAssertEqual(deletedEntryIds, [.string("t1"), .string("t2")], "both target slots are cleared, even the unmatched Lunch")
        let liveEntries = changes.filter { $0.table == "plan_entry" && $0.record["deleted"] != .number(1) }
        XCTAssertEqual(liveEntries.count, 1)
        XCTAssertEqual(liveEntries.first?.record["window_name"], .string("Breakfast"),
                       "only the copied Breakfast slot survives; the Lunch slot is not recreated")
    }

    func testCopyIntoAnEmptySlotAlwaysCreatesAPlannedSlot() throws {
        let f = copyFixture()
        let changes = try PlanEditing.copyChanges(
            sourceEntries: f.source, targetEntries: [], itemsByEntry: f.items,
            dayOffsets: ["2026-09-16": "2026-09-18"], mode: .skip, newId: idFactory())
        XCTAssertEqual(changes.map(\.table), ["plan_entry", "plan_item"])
        XCTAssertEqual(changes[0].record["date"], .string("2026-09-18"))
        XCTAssertEqual(changes[0].record["window_name"], .string("Lunch"))
        XCTAssertEqual(changes[0].record["status"], .string("planned"))
        XCTAssertEqual(changes[0].record["note"], .string("src"), "the note travels with the slot")
        XCTAssertEqual(changes[0].record["log_entry_id"], .null, "a copy is never linked to the source's log entry")
    }

    func testCopyAWholeWeekMapsEveryDay() throws {
        let source = [
            PlanEntryData(id: "s1", date: "2026-09-14", windowName: "Lunch", status: .planned),
            PlanEntryData(id: "s2", date: "2026-09-16", windowName: "Dinner", status: .planned),
        ]
        let offsets = Dictionary(uniqueKeysWithValues: PlanDate.week(containing: "2026-09-16")
            .map { ($0, PlanDate.shift($0, byDays: 7)) })
        let changes = try PlanEditing.copyChanges(
            sourceEntries: source, targetEntries: [], itemsByEntry: [:], dayOffsets: offsets,
            mode: .skip, newId: idFactory())
        XCTAssertEqual(changes.count, 2)
        XCTAssertEqual(changes[0].record["date"], .string("2026-09-21"))
        XCTAssertEqual(changes[1].record["date"], .string("2026-09-23"))
    }

    func testOccupiedTargetsAreReported() {
        let f = copyFixture()
        let occupied = PlanEditing.occupiedTargets(
            sourceEntries: f.source, targetEntries: f.target, dayOffsets: ["2026-09-16": "2026-09-17"])
        // slotKey normalizes the window name (Task 8), so the reported key is lowercased.
        XCTAssertEqual(occupied, ["2026-09-17|lunch"])
        XCTAssertTrue(PlanEditing.occupiedTargets(sourceEntries: f.source, targetEntries: [],
                                                  dayOffsets: ["2026-09-16": "2026-09-17"]).isEmpty)
    }

    func testCopySkipsSameDatePairs() throws {
        // Copying a day onto itself (e.g. an all-zero week offset) must not duplicate the slot.
        let f = copyFixture()
        let changes = try PlanEditing.copyChanges(
            sourceEntries: f.source, targetEntries: f.target, itemsByEntry: f.items,
            dayOffsets: ["2026-09-16": "2026-09-16"], mode: .replace, newId: idFactory())
        XCTAssertTrue(changes.isEmpty)
    }

    func testCopyRejectsAnUnparseableTargetDate() throws {
        let f = copyFixture()
        let changes = try PlanEditing.copyChanges(
            sourceEntries: f.source, targetEntries: [], itemsByEntry: f.items,
            dayOffsets: ["2026-09-16": "not-a-date"], mode: .skip, newId: idFactory())
        XCTAssertTrue(changes.isEmpty)
    }

    func testCopyNeverCreatesTwoLiveSlotsForTheSameTargetKey() throws {
        // Two source dates that (by a malformed or duplicated offsets map) land on the very same
        // target (date, window): the second must merge into the slot the first just created, not
        // duplicate it.
        let source = [
            PlanEntryData(id: "s1", date: "2026-09-14", windowName: "Lunch", status: .planned),
            PlanEntryData(id: "s2", date: "2026-09-15", windowName: "Lunch", status: .planned),
        ]
        let items: [Id: [PlanItemData]] = [
            "s1": [item("si1", "s1", "rice", 0)],
            "s2": [item("si2", "s2", "bread", 0)],
        ]
        let changes = try PlanEditing.copyChanges(
            sourceEntries: source, targetEntries: [], itemsByEntry: items,
            dayOffsets: ["2026-09-14": "2026-09-20", "2026-09-15": "2026-09-20"], mode: .merge, newId: idFactory())
        let liveEntries = changes.filter { $0.table == "plan_entry" }
        XCTAssertEqual(liveEntries.count, 1, "only one live plan_entry for the shared (date, window) key")
        let items2 = changes.filter { $0.table == "plan_item" }
        XCTAssertEqual(items2.count, 2)
        XCTAssertEqual(items2.map { $0.record["position"] }, [.number(0), .number(1)], "the second item appends after the first")
    }

    func testCopyTreatsDestinationWindowNamesCaseInsensitively() throws {
        // Target slot's window is "LUNCH" (different case from source's "Lunch"); it is still the
        // same slot identity, so occupiedTargets/copyChanges must not treat it as free.
        let f = copyFixture()
        var target = f.target
        target[0].windowName = "LUNCH"
        let occupied = PlanEditing.occupiedTargets(
            sourceEntries: f.source, targetEntries: target, dayOffsets: ["2026-09-16": "2026-09-17"])
        XCTAssertEqual(occupied, ["2026-09-17|lunch"])
    }

    // MARK: - conflictDates (per-day conflicts for the Copy sheet, spec §4)

    func testConflictDatesCountsAnyLiveEntryOnTheTargetDayEvenAnUnmatchedWindow() {
        // Target day has a Dinner entry only; the source copies a Lunch. Per-slot matching would see
        // no clash, but Replace clears the WHOLE day, so this must still count as a conflict.
        let target = [PlanEntryData(id: "t1", date: "2026-09-17", windowName: "Dinner", status: .planned)]
        XCTAssertEqual(PlanEditing.conflictDates(targetEntries: target, targetDates: ["2026-09-17", "2026-09-18"]),
                       ["2026-09-17"])
    }

    func testConflictDatesCountsLoggedEntriesToo() {
        // A logged breakfast is still a live entry that Replace would clear.
        let target = [PlanEntryData(id: "t1", date: "2026-09-17", windowName: "Breakfast", status: .logged)]
        XCTAssertEqual(PlanEditing.conflictDates(targetEntries: target, targetDates: ["2026-09-17"]), ["2026-09-17"])
    }

    func testConflictDatesIgnoresDaysWithNoLiveEntries() {
        XCTAssertTrue(PlanEditing.conflictDates(targetEntries: [], targetDates: ["2026-09-17", "2026-09-18"]).isEmpty)
    }

    func testConflictDatesDeduplicatesMultipleEntriesOnTheSameDay() {
        let target = [
            PlanEntryData(id: "t1", date: "2026-09-17", windowName: "Breakfast", status: .planned),
            PlanEntryData(id: "t2", date: "2026-09-17", windowName: "Lunch", status: .planned),
        ]
        XCTAssertEqual(PlanEditing.conflictDates(targetEntries: target, targetDates: ["2026-09-17"]), ["2026-09-17"])
    }

    // MARK: - Copy sheet target defaults and same-day guard (spec §4)

    func testDefaultCopyTargetIsNeverTheSourceDay() {
        XCTAssertEqual(PlanEditing.defaultCopyTarget(source: "2026-09-16"), "2026-09-17")
        XCTAssertNotEqual(PlanEditing.defaultCopyTarget(source: "2026-09-16"), "2026-09-16")
    }

    func testIsSelfCopyDetectsATargetEqualToTheSourceDay() {
        XCTAssertTrue(PlanEditing.isSelfCopy(sourceDate: "2026-09-16", targetDate: "2026-09-16"))
        XCTAssertFalse(PlanEditing.isSelfCopy(sourceDate: "2026-09-16", targetDate: "2026-09-17"))
        XCTAssertFalse(PlanEditing.isSelfCopy(sourceDate: nil, targetDate: "2026-09-16"), "a week copy has no single source date")
    }
}
