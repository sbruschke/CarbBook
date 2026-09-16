@testable import CarbBookKit
import Foundation
import XCTest

final class PlanDateTests: XCTestCase {
    /// A fixed calendar so the tests do not depend on the machine's locale or time zone.
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        calendar.firstWeekday = 1 // Sunday, matching the web Plan grid
        return calendar
    }

    private func date(_ text: String) -> Date {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.date(from: text)!
    }

    func testStringUsesTheLocalCalendarDate() {
        XCTAssertEqual(PlanDate.string(date("2026-09-16 23:30"), calendar: calendar), "2026-09-16")
        XCTAssertEqual(PlanDate.string(date("2026-09-17 00:05"), calendar: calendar), "2026-09-17")
    }

    func testDateParsesBackToNoonSoDstNeverShiftsTheDay() {
        let parsed = PlanDate.date("2026-03-08", calendar: calendar)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(PlanDate.string(parsed!, calendar: calendar), "2026-03-08")
        XCTAssertEqual(calendar.component(.hour, from: parsed!), 12)
    }

    func testDateRejectsMalformedText() {
        XCTAssertNil(PlanDate.date("2026-9-8", calendar: calendar))
        XCTAssertNil(PlanDate.date("not a date", calendar: calendar))
        XCTAssertNil(PlanDate.date("", calendar: calendar))
    }

    func testWeekReturnsSevenDatesStartingOnTheCalendarsFirstWeekday() {
        let week = PlanDate.week(containing: "2026-09-16", calendar: calendar)
        XCTAssertEqual(week.count, 7)
        XCTAssertEqual(week.first, "2026-09-13") // Sunday
        XCTAssertEqual(week.last, "2026-09-19")
        XCTAssertTrue(week.contains("2026-09-16"))
    }

    func testShiftMovesByWholeDays() {
        XCTAssertEqual(PlanDate.shift("2026-09-16", byDays: 1, calendar: calendar), "2026-09-17")
        XCTAssertEqual(PlanDate.shift("2026-09-16", byDays: -1, calendar: calendar), "2026-09-15")
        XCTAssertEqual(PlanDate.shift("2026-09-16", byDays: 7, calendar: calendar), "2026-09-23")
        XCTAssertEqual(PlanDate.shift("2026-12-31", byDays: 1, calendar: calendar), "2027-01-01")
    }

    func testSlotKeyMatchesTheWebAppsFormat() {
        // The web app's slotKey trims and lowercases the window name to match the server's
        // case-insensitive uniqueness rule (web/src/plan/slots.ts); the Swift key must agree.
        XCTAssertEqual(PlanDate.slotKey(date: "2026-09-16", windowName: "Lunch"), "2026-09-16|lunch")
    }

    func testSlotKeyNormalizesWhitespaceAndCase() {
        XCTAssertEqual(PlanDate.slotKey(date: "2026-09-16", windowName: "  Lunch  "), "2026-09-16|lunch")
        XCTAssertEqual(PlanDate.slotKey(date: "2026-09-16", windowName: "LUNCH"), "2026-09-16|lunch")
        XCTAssertEqual(PlanDate.slotKey(date: "2026-09-16", windowName: "Lunch"),
                       PlanDate.slotKey(date: "2026-09-16", windowName: "lunch"))
    }
}
