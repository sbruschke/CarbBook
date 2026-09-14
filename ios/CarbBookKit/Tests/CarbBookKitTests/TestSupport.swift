import CarbBookCore
@testable import CarbBookKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import GRDB

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int64

    init(_ ms: Int64) { value = ms }

    var ms: Int64 {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }

    var now: @Sendable () -> Int64 { { self.ms } }
}

func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("carbbook-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

func json(_ text: String) -> Data { Data(text.utf8) }

/// Minimal CarbBook server: LWW via `isNewer`, one server_seq per accepted write, paged pull.
actor FakeServer: SyncTransport {
    var rows: [String: SyncChange] = [:]
    var seq: Int64 = 0
    var pullCount = 0
    var failWith: Error?

    func setFailure(_ error: Error?) { failWith = error }

    func push(_ changes: [SyncChange]) throws -> PushResponse {
        if let failWith { throw failWith }
        var results: [PushResult] = []
        for change in changes {
            let id = change.id ?? ""
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

    func pull(since: Int64, limit: Int) throws -> PullResponse {
        if let failWith { throw failWith }
        pullCount += 1
        let newer = rows.values
            .filter { ($0.record["server_seq"]?.int64Value ?? 0) > since }
            .sorted { $0.record["server_seq"]!.int64Value! < $1.record["server_seq"]!.int64Value! }
        let page = Array(newer.prefix(limit))
        return PullResponse(changes: page, nextSince: page.last?.record["server_seq"]?.int64Value ?? since, hasMore: newer.count > limit)
    }
}

/// Writes a USDA bundle with the server's BUNDLE_SCHEMA (server-data plan, Task 10).
func makeUsdaBundle(at path: String, version: String) throws {
    let queue = try DatabaseQueue(path: path)
    try queue.write { db in
        try db.execute(sql: """
        CREATE TABLE usda_food (fdc_id INTEGER PRIMARY KEY, name TEXT NOT NULL, carbs_per_100g REAL, fiber_per_100g REAL);
        CREATE TABLE usda_portion (id INTEGER PRIMARY KEY, fdc_id INTEGER NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
          quantity REAL NOT NULL, grams REAL NOT NULL, description TEXT NOT NULL);
        CREATE INDEX usda_portion_fdc ON usda_portion (fdc_id);
        CREATE VIRTUAL TABLE usda_fts USING fts5 (name, content = 'usda_food', content_rowid = 'fdc_id',
          tokenize = 'unicode61 remove_diacritics 2');
        CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO usda_food VALUES (168878, 'Rice, white, long-grain, cooked', 28.2, 0.4);
        INSERT INTO usda_food VALUES (169704, 'Crème fraîche', 2.8, 0);
        INSERT INTO usda_food VALUES (323505, 'Kale, raw', 4.4, 4.1);
        INSERT INTO usda_portion VALUES (1, 168878, 'cup', 'volume', 1, 158, '1 cup');
        INSERT INTO usda_portion VALUES (2, 168878, 'serving', 'serving', 1, 125, '1 serving');
        INSERT INTO usda_fts (usda_fts) VALUES ('rebuild');
        """)
        try db.execute(sql: "INSERT INTO bundle_meta VALUES ('version', ?)", arguments: [version])
    }
}
