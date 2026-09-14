import XCTest
@testable import CarbBookCore

/// In-memory client store with the same rules the GRDB store implements.
actor MemorySyncStore: SyncStore {
    let deviceId: String
    var rows: [String: SyncChange] = [:]
    var pending: [String] = []
    /// Last server-acknowledged copy of each row that has ever been synced (accepted, or pulled).
    /// Absence means the row has never been synced — a rejection of it deletes the row.
    var synced: [String: SyncChange] = [:]
    var rejections: [PushResult] = []
    var cursor: Int64 = 0
    var lastSynced: Int64?

    init(deviceId: String) { self.deviceId = deviceId }

    func write(_ table: String, _ fields: [String: JSONValue], at ms: Int64, deleted: Bool = false) {
        var record = fields
        record["updated_at"] = .number(Double(ms))
        record["updated_by"] = .string(deviceId)
        record["deleted"] = .number(deleted ? 1 : 0)
        let change = SyncChange(table: table, record: record)
        rows[change.key] = change
        if !pending.contains(change.key) { pending.append(change.key) }
    }

    func name(_ key: String) -> String? { rows[key]?.record["name"]?.stringValue }
    func isDeleted(_ key: String) -> Bool { rows[key]?.record["deleted"] == .number(1) }
    func exists(_ key: String) -> Bool { rows[key] != nil }

    func pendingChanges(limit: Int) -> [SyncChange] { pending.prefix(limit).compactMap { rows[$0] } }

    /// `pushed` and `results` are matched by index, per the protocol contract — never by
    /// `result.id`, which may be null.
    func recordPushResults(_ pushed: [SyncChange], _ results: [PushResult]) {
        for (sent, result) in zip(pushed, results) {
            let key = sent.key
            let noNewerLocalEdit = rows[key]?.version == sent.version
            if result.status == "rejected" {
                guard noNewerLocalEdit else { continue } // newer local edit: leave queued, untouched
                if let snapshot = synced[key] {
                    rows[key] = snapshot
                } else {
                    rows.removeValue(forKey: key) // never synced: delete
                }
                pending.removeAll { $0 == key }
                rejections.append(result)
            } else if noNewerLocalEdit {
                pending.removeAll { $0 == key }
                if result.status == "accepted" { synced[key] = sent }
            }
        }
    }

    func pullCursor() -> Int64 { cursor }

    func applyPull(_ changes: [SyncChange], nextSince: Int64) {
        for change in changes {
            guard let incoming = change.version else { continue }
            let isPending = pending.contains(change.key)
            if shouldApplyPulled(incoming: incoming, local: rows[change.key]?.version, localPending: isPending) {
                var record = change.record
                record.removeValue(forKey: "server_seq")
                let applied = SyncChange(table: change.table, record: record)
                rows[change.key] = applied
                synced[change.key] = applied
                pending.removeAll { $0 == change.key }
            }
        }
        cursor = nextSince
    }

    func setLastSynced(_ ms: Int64) { lastSynced = ms }
}

/// Minimal server: LWW via `isNewer`, one server_seq per accepted write, paged pull.
actor FakeServer: SyncTransport {
    var rows: [String: SyncChange] = [:]
    var seq: Int64 = 0
    var failNextWith: Error?

    func push(_ changes: [SyncChange]) throws -> PushResponse {
        if let error = failNextWith { failNextWith = nil; throw error }
        var results: [PushResult] = []
        for change in changes {
            let id = change.id
            guard SyncTables.all.contains(change.table) else {
                results.append(PushResult(table: change.table, id: id, status: "rejected", reason: "unknown_table", message: "unknown table"))
                continue
            }
            let stored = rows[change.key]
            if let incoming = change.version, isNewer(incoming, than: stored?.version) {
                seq += 1
                var record = change.record
                record["server_seq"] = .number(Double(seq))
                rows[change.key] = SyncChange(table: change.table, record: record)
                results.append(PushResult(table: change.table, id: id, status: "accepted", serverSeq: seq))
            } else {
                results.append(PushResult(table: change.table, id: id, status: "ignored", serverSeq: stored?.record["server_seq"]?.int64Value))
            }
        }
        return PushResponse(results: results, serverSeq: seq)
    }

    func pull(since: Int64, limit: Int) -> PullResponse {
        let newer = rows.values
            .filter { ($0.record["server_seq"]?.int64Value ?? 0) > since }
            .sorted { $0.record["server_seq"]!.int64Value! < $1.record["server_seq"]!.int64Value! }
        let page = Array(newer.prefix(limit))
        return PullResponse(changes: page, nextSince: page.last?.record["server_seq"]?.int64Value ?? since, hasMore: newer.count > limit)
    }

    func failNextPush(_ error: Error) { failNextWith = error }
}

struct Unauthorized: Error {}

final class SyncEngineTests: XCTestCase {
    func testOfflineEditsConvergeWithLastWriteWinning() async throws {
        let server = FakeServer()
        let phone = MemorySyncStore(deviceId: "phone")
        let laptop = MemorySyncStore(deviceId: "laptop")
        await phone.write("food", ["id": .string("f1"), "name": .string("Tortilla")], at: 1_000)
        _ = try await SyncEngine(store: phone, transport: server).run { 1_100 }
        _ = try await SyncEngine(store: laptop, transport: server).run { 1_200 }
        let laptopName = await laptop.name("food/f1")
        XCTAssertEqual(laptopName, "Tortilla")

        // Both edit offline; the laptop's edit is later.
        await phone.write("food", ["id": .string("f1"), "name": .string("Flour tortilla")], at: 2_000)
        await laptop.write("food", ["id": .string("f1"), "name": .string("Corn tortilla")], at: 3_000)
        let laptopReport = try await SyncEngine(store: laptop, transport: server).run { 3_100 }
        XCTAssertEqual(laptopReport.accepted, 1)
        let phoneReport = try await SyncEngine(store: phone, transport: server).run { 3_200 }
        XCTAssertEqual(phoneReport.ignored, 1)
        let phoneName = await phone.name("food/f1")
        let phonePending = await phone.pending
        let phoneLastSynced = await phone.lastSynced
        XCTAssertEqual(phoneName, "Corn tortilla")
        XCTAssertEqual(phonePending, [])
        XCTAssertEqual(phoneLastSynced, 3_200)
    }

    func testEqualTimestampsGoToHigherDeviceId() async throws {
        let server = FakeServer()
        let phone = MemorySyncStore(deviceId: "phone")
        let laptop = MemorySyncStore(deviceId: "laptop")
        await laptop.write("meal", ["id": .string("m1"), "name": .string("Laptop tacos")], at: 5_000)
        await phone.write("meal", ["id": .string("m1"), "name": .string("Phone tacos")], at: 5_000)
        _ = try await SyncEngine(store: laptop, transport: server).run { 5_100 }
        _ = try await SyncEngine(store: phone, transport: server).run { 5_200 }
        _ = try await SyncEngine(store: laptop, transport: server).run { 5_300 }
        let laptopName = await laptop.name("meal/m1")
        let phoneName = await phone.name("meal/m1")
        XCTAssertEqual(laptopName, "Phone tacos")
        XCTAssertEqual(phoneName, "Phone tacos")
    }

    func testSoftDeletePropagates() async throws {
        let server = FakeServer()
        let phone = MemorySyncStore(deviceId: "phone")
        let laptop = MemorySyncStore(deviceId: "laptop")
        await phone.write("food", ["id": .string("f1"), "name": .string("Rice")], at: 1_000)
        _ = try await SyncEngine(store: phone, transport: server).run { 1_000 }
        _ = try await SyncEngine(store: laptop, transport: server).run { 1_000 }
        await laptop.write("food", ["id": .string("f1"), "name": .string("Rice")], at: 2_000, deleted: true)
        _ = try await SyncEngine(store: laptop, transport: server).run { 2_000 }
        _ = try await SyncEngine(store: phone, transport: server).run { 2_000 }
        let deleted = await phone.isDeleted("food/f1")
        XCTAssertTrue(deleted)
    }

    func testRejectionsAreKeptAndClearedFromPending() async throws {
        let server = FakeServer()
        let phone = MemorySyncStore(deviceId: "phone")
        await phone.write("recipe", ["id": .string("r1")], at: 1_000)
        let report = try await SyncEngine(store: phone, transport: server).run { 1_000 }
        XCTAssertEqual(report.rejected.map(\.reason), ["unknown_table"])
        let pending = await phone.pending
        let rejections = await phone.rejections
        XCTAssertEqual(pending, [])
        XCTAssertEqual(rejections.count, 1)
    }

    func testPullPagesUntilDrained() async throws {
        let server = FakeServer()
        let phone = MemorySyncStore(deviceId: "phone")
        for i in 1...1_203 {
            await phone.write("food", ["id": .string("f\(i)"), "name": .string("Food \(i)")], at: Int64(i))
        }
        let laptop = MemorySyncStore(deviceId: "laptop")
        let pushReport = try await SyncEngine(store: phone, transport: server).run { 2_000 }
        XCTAssertEqual(pushReport.accepted, 1_203) // three push batches of ≤500
        let pullReport = try await SyncEngine(store: laptop, transport: server).run { 2_000 }
        XCTAssertEqual(pullReport.pulled, 1_203)
        let cursor = await laptop.cursor
        XCTAssertEqual(cursor, 1_203)
    }

    /// Item 1/2: a rejection uses the same updated_at version check as accepted results, and
    /// restores the last server-acknowledged snapshot rather than leaving the row diverged.
    func testRejectedEditOfSyncedRowRestoresServerCopy() async throws {
        let phone = MemorySyncStore(deviceId: "phone")
        await phone.write("food", ["id": .string("f1"), "name": .string("Rice")], at: 1_000)
        await phone.recordPushResults(await phone.pendingChanges(limit: 10),
                                       [PushResult(table: "food", id: "f1", status: "accepted", serverSeq: 1)])
        let nameAfterSync = await phone.name("food/f1")
        XCTAssertEqual(nameAfterSync, "Rice")

        await phone.write("food", ["id": .string("f1"), "name": .string("Brown rice")], at: 2_000)
        let pushed = await phone.pendingChanges(limit: 10)
        await phone.recordPushResults(pushed, [PushResult(table: "food", id: "f1", status: "rejected", reason: "invalid", message: "bad")])

        let name = await phone.name("food/f1")
        let pending = await phone.pending
        let rejections = await phone.rejections
        XCTAssertEqual(name, "Rice") // restored to the last server-acknowledged copy
        XCTAssertEqual(pending, [])
        XCTAssertEqual(rejections.map(\.reason), ["invalid"])
    }

    /// Item 2: a row that was never synced is deleted on rejection, not left diverged forever.
    func testRejectedNeverSyncedRowIsDeleted() async throws {
        let phone = MemorySyncStore(deviceId: "phone")
        await phone.write("food", ["id": .string("f1"), "name": .string("Rice")], at: 1_000)
        let pushed = await phone.pendingChanges(limit: 10)
        await phone.recordPushResults(pushed, [PushResult(table: "food", id: "f1", status: "rejected", reason: "invalid", message: "bad")])

        let exists = await phone.exists("food/f1")
        let pending = await phone.pending
        XCTAssertFalse(exists)
        XCTAssertEqual(pending, [])
    }

    /// Item 2: if the row was edited again while the rejected push was in flight, the rejection
    /// must not clobber that newer edit — it stays queued for the next sync.
    func testRejectionWhileNewerLocalEditExistsKeepsNewerEditQueued() async throws {
        let phone = MemorySyncStore(deviceId: "phone")
        await phone.write("food", ["id": .string("f1"), "name": .string("Rice")], at: 1_000)
        await phone.recordPushResults(await phone.pendingChanges(limit: 10),
                                       [PushResult(table: "food", id: "f1", status: "accepted", serverSeq: 1)])

        await phone.write("food", ["id": .string("f1"), "name": .string("Brown rice")], at: 2_000)
        let pushed = await phone.pendingChanges(limit: 10) // captures the 2_000 edit as "in flight"
        await phone.write("food", ["id": .string("f1"), "name": .string("Jasmine rice")], at: 3_000)
        await phone.recordPushResults(pushed, [PushResult(table: "food", id: "f1", status: "rejected", reason: "invalid", message: "bad")])

        let name = await phone.name("food/f1")
        let pending = await phone.pending
        let rejections = await phone.rejections
        XCTAssertEqual(name, "Jasmine rice") // newer local edit is untouched
        XCTAssertEqual(pending, ["food/f1"]) // still queued to retry
        XCTAssertEqual(rejections, [])
    }

    func testFailedPushKeepsPendingAndCursor() async throws {
        let server = FakeServer()
        let phone = MemorySyncStore(deviceId: "phone")
        await phone.write("food", ["id": .string("f1"), "name": .string("Rice")], at: 1_000)
        await server.failNextPush(Unauthorized())
        do {
            _ = try await SyncEngine(store: phone, transport: server).run { 1_000 }
            XCTFail("expected an error")
        } catch is Unauthorized {}
        let pending = await phone.pending
        let lastSynced = await phone.lastSynced
        XCTAssertEqual(pending, ["food/f1"])
        XCTAssertNil(lastSynced)
    }
}
