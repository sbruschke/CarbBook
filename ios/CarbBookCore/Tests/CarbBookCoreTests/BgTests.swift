import XCTest
@testable import CarbBookCore

/// Runs `testdata/bg-stats-vectors.json` — the same cases as the TS core's bg.test.ts.
final class BgTests: XCTestCase {
    struct Vectors: Decodable {
        struct Stats: Decodable {
            let count: Int; let coverage: Double; let mean: Double; let sd: Double; let cv: Double; let gmi: Double
            let min: Double; let max: Double; let bands: [String: Double]
        }
        struct StatsCase: Decodable { let name: String; let points: [BgPoint]; let span_ms: Double; let expect: Stats? }
        struct MealCase: Decodable { let name: String; let points: [BgPoint]; let eaten_at: Int64; let expect: MealResponse }
        struct Hour: Decodable {
            let hour: Int; let count: Int; let p10: Double?; let p25: Double?; let p50: Double?; let p75: Double?; let p90: Double?
        }
        struct PatternCase: Decodable { let name: String; let points: [BgPoint]; let expect: [Hour] }
        let tolerance: Double
        let stats_cases: [StatsCase]
        let meal_cases: [MealCase]
        let pattern_cases: [PatternCase]
    }

    private func vectors() throws -> Vectors {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "bg-stats-vectors", withExtension: "json", subdirectory: "Resources"))
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func close(_ a: Double?, _ b: Double?, _ tol: Double, _ label: String) {
        guard let b else { return XCTAssertNil(a, label) }
        XCTAssertEqual(a ?? .nan, b, accuracy: tol, label)
    }

    func testStatsVectors() throws {
        let v = try vectors()
        XCTAssertFalse(v.stats_cases.isEmpty)
        for c in v.stats_cases {
            let s = bgStats(c.points, spanMs: c.span_ms)
            guard let want = c.expect else { XCTAssertNil(s, c.name); continue }
            let got = try XCTUnwrap(s, c.name)
            XCTAssertEqual(got.count, want.count, c.name)
            for (a, b, k) in [(got.coverage, want.coverage, "coverage"), (got.mean, want.mean, "mean"), (got.sd, want.sd, "sd"),
                              (got.cv, want.cv, "cv"), (got.gmi, want.gmi, "gmi"), (got.min, want.min, "min"), (got.max, want.max, "max")] {
                close(a, b, v.tolerance, "\(c.name) \(k)")
            }
            for band in BgBand.allCases { close(got.bands[band], want.bands[band.rawValue], v.tolerance, "\(c.name) \(band)") }
        }
    }

    func testMealVectors() throws {
        let v = try vectors()
        XCTAssertFalse(v.meal_cases.isEmpty)
        for c in v.meal_cases { XCTAssertEqual(mealResponse(c.points, eatenAt: c.eaten_at), c.expect, c.name) }
    }

    func testPatternVectors() throws {
        let v = try vectors()
        for c in v.pattern_cases {
            let got = dailyPattern(c.points) { Int(($0 / 3_600_000) % 24) }
            XCTAssertEqual(got.map(\.hour), c.expect.map(\.hour), c.name)
            XCTAssertEqual(got.map(\.count), c.expect.map(\.count), c.name)
            for (g, w) in zip(got, c.expect) {
                for (a, b, k) in [(g.p10, w.p10, "p10"), (g.p25, w.p25, "p25"), (g.p50, w.p50, "p50"), (g.p75, w.p75, "p75"), (g.p90, w.p90, "p90")] {
                    close(a, b, v.tolerance, "\(c.name) \(g.hour) \(k)")
                }
            }
        }
    }

    func testBandEdges() {
        XCTAssertEqual([53, 54, 69, 70, 180, 181, 250, 251].map { bgBand(Double($0)) },
                       [.veryLow, .low, .low, .inRange, .inRange, .high, .high, .veryHigh])
    }
}
