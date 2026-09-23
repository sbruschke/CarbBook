import CarbBookCore
@testable import CarbBookKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest

final class WebhookSenderTests: XCTestCase {
    let hook = "https://discord.com/api/webhooks/123456789012345678/token-here"

    private func content(_ request: URLRequest) throws -> String {
        let body = try JSONDecoder().decode([String: String].self, from: XCTUnwrap(request.httpBody))
        return try XCTUnwrap(body["content"])
    }

    func testPostsTheMessageAsDiscordShapedJsonWithoutCookies() async throws {
        let stub = StubTransport { _ in (204, Data()) }
        try await WebhookSender(transport: stub).send("hello", to: hook)
        let request = try XCTUnwrap(stub.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, hook)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertFalse(request.httpShouldHandleCookies)
        XCTAssertEqual(try content(request), "hello")
    }

    func testNamesAWrongOrDeletedWebhook() async {
        let stub = StubTransport { _ in (404, Data()) }
        do {
            try await WebhookSender(transport: stub).send("hi", to: hook)
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? WebhookError, .badWebhook)
            XCTAssertTrue((error as? WebhookError)?.message.contains("wrong or has been deleted") ?? false)
        }
    }

    func testOtherStatusesAreReportedWithTheirCode() async {
        let stub = StubTransport { _ in (500, Data()) }
        do {
            try await WebhookSender(transport: stub).send("hi", to: hook)
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? WebhookError, .rejected(status: 500))
        }
    }

    func testAnUnusableUrlIsRefusedBeforeAnythingIsSent() async {
        let stub = StubTransport { _ in (204, Data()) }
        do {
            try await WebhookSender(transport: stub).send("hi", to: "http://discord.com/api/webhooks/1/abc")
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? WebhookError, .invalidUrl("The webhook URL must start with https://."))
            XCTAssertTrue(stub.requests.isEmpty, "nothing may be sent over http")
        }
    }

    func testItemLinesUseTheLoggedSnapshotAndResolvePortionUnits() {
        let slice = PortionData(id: "s", foodId: "bread", label: "slice", kind: "count", quantity: 2, grams: 60)
        let catalog = InMemoryCatalog(
            foods: [FoodData(id: "bread", name: "Bread", source: "custom", carbsPer100g: 50)], portions: [slice])
        let items = [
            LogItemData(id: "i1", logEntryId: "e", refType: .food, refId: "bread", displayName: "Bread",
                        amount: 2, unit: "p:s", carbsG: 30),
            LogItemData(id: "i2", logEntryId: "e", refType: .quick, refId: "i2", displayName: "Gatorade",
                        amount: 23, unit: Units.quick, carbsG: 23),
        ]
        let lines = webhookItemLines(for: items, catalog: catalog)
        XCTAssertEqual(lines, [
            WebhookItemLine(name: "Bread", amount: "2 slice (30 g)", carbsG: 30),
            // A quick row says its carbs once, not twice.
            WebhookItemLine(name: "Gatorade", amount: "", carbsG: 23),
        ])
        let message = webhookMessage(
            AccountabilityInput(when: "9/20/26, 12:24:58 PM CDT", bgMgdl: 170, carbsG: 53, units: 6), items: lines)
        XCTAssertTrue(message.contains("In it:\n• Bread — 2 slice (30 g) · 30 g carbs\n• Gatorade — 23 g carbs"))
    }
}
