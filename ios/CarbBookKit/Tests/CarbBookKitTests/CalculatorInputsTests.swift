import CarbBookCore
@testable import CarbBookKit
import XCTest

final class CalculatorInputsTests: XCTestCase {
    let catalog = InMemoryCatalog(foods: [FoodData(id: "rice", name: "Rice", carbsPer100g: 28.2)])
    let settings = DoseSettingsData(
        id: "s1", effectiveFrom: 0,
        windows: [DoseWindow(name: "All day", start: "00:00", ratioGPerUnit: 10)],
        correction: CorrectionRule(threshold: 150, step: 50, unitsPerStep: 1, mode: "started"),
        rounding: RoundingRule(increment: 0.5, roundDownBelowBg: nil))
    let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    let now: Int64 = 1_789_408_800_000

    private func line(_ text: String) -> CalculatorLine {
        CalculatorLine(id: "l1", refType: .food, refId: "rice", displayName: "Rice",
                       amount: AmountInput.modelAmount(text), unit: "g")
    }

    private func evaluate(_ lines: [CalculatorLine]) -> CalculatorResult {
        evaluateCalculator(lines: lines, catalog: catalog, settingsVersions: [settings], eatenAt: Date(timeIntervalSince1970: 1_789_408_800),
                           calendar: utc, windowOverride: nil, bg: .none, lastDoseAtMs: nil, nowMs: now)
    }

    // MARK: 1. Amount fields

    func testAmountTextMapsToModelAmount() {
        XCTAssertEqual(AmountInput.modelAmount("1.5"), 1.5)
        XCTAssertEqual(AmountInput.modelAmount("1,5"), 1.5)
        XCTAssertTrue(AmountInput.modelAmount("15g").isNaN)
        XCTAssertTrue(AmountInput.modelAmount("").isNaN)
        XCTAssertTrue(AmountInput.modelAmount("0x10").isNaN)

        XCTAssertFalse(AmountInput.isInvalid("1.5"))
        XCTAssertFalse(AmountInput.isInvalid("1,5"))
        XCTAssertTrue(AmountInput.isInvalid("15g"))
        XCTAssertTrue(AmountInput.isInvalid(""))
        XCTAssertTrue(AmountInput.isInvalid("0x10"))
        XCTAssertEqual(AmountInput.invalidMessage, "Invalid amount")
    }

    func testInvalidAmountTextMakesCoreRefuse() {
        XCTAssertEqual(evaluate([line("100")]).lineCarbs.first?.complete, true)
        for text in ["15g", "", "0x10"] {
            let result = evaluate([line(text)])
            XCTAssertEqual(result.lineCarbs.first?.complete, false, text)
            guard case .refused? = result.estimate else { return XCTFail("expected refusal for \(text)") }
            XCTAssertTrue(AmountInput.hasInvalidAmount([line(text)]), text)
        }
        XCTAssertFalse(AmountInput.hasInvalidAmount([line("1,5")]))
    }

    /// NaN != NaN, so `[CalculatorLine]` with an invalid amount never equals itself; SwiftUI
    /// `onChange` must observe this key instead or it would recompute in a loop.
    func testChangeKeyIsStableForInvalidAmounts() {
        XCTAssertNotEqual([line("15g")], [line("15g")])
        XCTAssertEqual(AmountInput.changeKey([line("15g")]), AmountInput.changeKey([line("15g")]))
        XCTAssertNotEqual(AmountInput.changeKey([line("15g")]), AmountInput.changeKey([line("15")]))
        var other = line("15")
        other.unit = "oz"
        XCTAssertNotEqual(AmountInput.changeKey([line("15")]), AmountInput.changeKey([other]))
    }

    func testInitialTextRoundTripsThroughParser() {
        for amount in [100, 1, 0.5, 1.0 / 3, 255.3191489, 0.0000001, 0] {
            XCTAssertEqual(NumberParsing.parseAmount(AmountInput.text(for: amount))!, amount, accuracy: 1e-9, "\(amount)")
        }
        XCTAssertEqual(AmountInput.text(for: 100), "100")
        XCTAssertEqual(AmountInput.text(for: 1.5), "1.5")
        XCTAssertEqual(AmountInput.text(for: .nan), "")
    }

    // MARK: 2/3. Taken dose

    func testTakenForLogBlocksMalformedButAllowsEmpty() throws {
        XCTAssertNil(try TakenDoseInput.unitsForLog(""))
        XCTAssertNil(try TakenDoseInput.unitsForLog("  "))
        XCTAssertEqual(try TakenDoseInput.unitsForLog("2.5"), 2.5)
        XCTAssertEqual(try TakenDoseInput.unitsForLog("2,5"), 2.5)
        XCTAssertThrowsError(try TakenDoseInput.unitsForLog("2..5")) { error in
            XCTAssertEqual(error as? TakenDoseError, .malformed)
            XCTAssertEqual((error as? TakenDoseError)?.message, "Taken dose must be a number")
        }
        XCTAssertThrowsError(try TakenDoseInput.unitsForLog("abc"))
    }

    func testTakenForEditNeverWipesStoredValueOnInvalidText() throws {
        // Unedited: stored value is kept verbatim.
        XCTAssertEqual(try TakenDoseInput.unitsForEdit(text: "2.33", loadedText: "2.33", stored: 2.333), 2.333)
        // Edited to a valid number / cleared.
        XCTAssertEqual(try TakenDoseInput.unitsForEdit(text: "3", loadedText: "2.33", stored: 2.333), 3)
        XCTAssertNil(try TakenDoseInput.unitsForEdit(text: "", loadedText: "2.33", stored: 2.333))
        // Edited but malformed: blocked.
        XCTAssertThrowsError(try TakenDoseInput.unitsForEdit(text: "2..5", loadedText: "2.33", stored: 2.333)) { error in
            XCTAssertEqual(error as? TakenDoseError, .malformed)
        }
    }

    // MARK: 6. Taken field ownership

    func testTakenFieldEditedWheneverUserTypedEvenIfTextMatchesEstimate() {
        var field = TakenField()
        field.applyEstimate("2.5")
        XCTAssertEqual(field.text, "2.5")
        XCTAssertFalse(field.editedByUser)

        field.userTyped("3")
        field.userTyped("3.5") // happens to equal the next estimate
        field.applyEstimate("3.5")
        XCTAssertTrue(field.editedByUser)
        field.applyEstimate("4")
        XCTAssertEqual(field.text, "3.5", "a user-typed value is never overwritten by a new estimate")

        field.reset()
        XCTAssertFalse(field.editedByUser)
        XCTAssertEqual(field.text, "")
        field.applyEstimate("1")
        XCTAssertEqual(field.text, "1")
    }

    // MARK: 4. BG freshness clock

    private func reading(readAt: Int64, fresh: Bool = true) -> BgReading {
        BgReading(mgdl: 250, trend: "Flat", arrow: "→", deltaMgdl: nil, readAt: readAt, ageMs: 0, fresh: fresh)
    }

    private func inputs(manualBg: String = "", lastDose: Int64? = nil) -> CalculatorInputs {
        CalculatorInputs(lines: [line("100")], catalog: catalog, settingsVersions: [settings], useNow: true,
                         eatenAt: Date(timeIntervalSince1970: 0), windowOverride: nil, manualBg: manualBg,
                         lastDoseAtMs: lastDose, rejectedSettingsIds: [])
    }

    func testRecomputeDropsDexcomOnceReadingGoesStale() {
        let readAt = now
        let fresh = recomputeCalculator(inputs(), dexcom: .reading(reading(readAt: readAt)), nowMs: now, calendar: utc)
        XCTAssertEqual(fresh.dexcomBg, .dexcom(mgdl: 250, trend: "Flat"))
        XCTAssertEqual(fresh.bgStatus, .usable(minutesAgo: 0))
        guard case .ok(let s1)? = fresh.result.estimate else { return XCTFail("expected dose") }
        XCTAssertEqual(s1.bg, 250)
        XCTAssertEqual(s1.correctionUnits, 2)

        let later = now + 16 * 60_000
        let stale = recomputeCalculator(inputs(), dexcom: .reading(reading(readAt: readAt)), nowMs: later, calendar: utc)
        XCTAssertEqual(stale.dexcomBg, .none)
        XCTAssertEqual(stale.bg, .none)
        XCTAssertEqual(stale.bgStatus, .stale(minutesOld: 16))
        guard case .ok(let s2)? = stale.result.estimate else { return XCTFail("expected dose") }
        XCTAssertNil(s2.bg)
        XCTAssertEqual(s2.correctionUnits, 0)
        XCTAssertEqual(stale.eatenAt, Date(timeIntervalSince1970: Double(later) / 1000), "useNow tracks the clock")
    }

    func testRecomputeUsesManualBgWhenDexcomStaleAndRefreshesRecentDoseWarning() {
        let lastDose = now - 4 * 3_600_000 + 60_000
        let early = recomputeCalculator(inputs(manualBg: "120", lastDose: lastDose), dexcom: .reading(reading(readAt: now - 20 * 60_000)),
                                        nowMs: now, calendar: utc)
        XCTAssertEqual(early.bg, .manual(mgdl: 120))
        XCTAssertTrue(early.result.recentDoseWarning)
        let late = recomputeCalculator(inputs(manualBg: "120", lastDose: lastDose), dexcom: .reading(reading(readAt: now - 20 * 60_000)),
                                       nowMs: now + 2 * 60_000, calendar: utc)
        XCTAssertFalse(late.result.recentDoseWarning)

        let invalid = recomputeCalculator(inputs(manualBg: "12.5"), dexcom: .failed, nowMs: now, calendar: utc)
        XCTAssertEqual(invalid.bgStatus, .unavailable)
        guard case .refused(.invalidInput, _)? = invalid.result.estimate else { return XCTFail("expected invalid_input") }
    }

    func testBgStatusForServerStaleFutureAndNotLoaded() {
        XCTAssertEqual(recomputeCalculator(inputs(), dexcom: .reading(reading(readAt: now, fresh: false)), nowMs: now, calendar: utc).bgStatus,
                       .stale(minutesOld: 0))
        XCTAssertEqual(recomputeCalculator(inputs(), dexcom: .reading(reading(readAt: now + 3 * 60_000)), nowMs: now, calendar: utc).bgStatus,
                       .future)
        XCTAssertEqual(recomputeCalculator(inputs(), dexcom: .notLoaded, nowMs: now, calendar: utc).bgStatus, .checking)
    }

    // MARK: 6. Sign-out user cache

    func testUserCacheClear() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "carbbook-test-\(UUID().uuidString)"))
        let user = ApiUser(id: 1, username: "brett", role: "owner")
        try UserCache.save(user, to: defaults)
        XCTAssertEqual(UserCache.load(from: defaults), user)
        UserCache.clear(defaults)
        XCTAssertNil(UserCache.load(from: defaults))
    }
}
