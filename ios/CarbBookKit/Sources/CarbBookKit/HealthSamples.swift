import CarbBookCore
import Foundation

/// One Apple Health sample a log entry produces. Deliberately free of HealthKit types: this file
/// compiles and is tested on Linux, and the app's HealthWriter does the HKQuantitySample conversion.
public struct HealthSample: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// Dietary carbohydrates, grams.
        case carbohydrates
        /// Insulin delivery, international units, reason = bolus.
        case insulinBolus
    }
    public var kind: Kind
    public var value: Double
    /// Milliseconds since the epoch; the sample's start and end are both this instant.
    public var at: Int64
    /// The log entry's id, carried into HKMetadataKeyExternalUUID.
    public var externalId: String

    public init(kind: Kind, value: Double, at: Int64, externalId: String) {
        self.kind = kind; self.value = value; self.at = at; self.externalId = externalId
    }
}

/// The samples a saved log entry should add to Apple Health (spec §1).
///
/// Only the *taken* dose is ever written: the suggested estimate is a recommendation, and Health
/// must not record insulin that may not have been injected. Zero, missing, negative and non-finite
/// values produce no sample rather than a zero one — a zero carb sample is a lie about the meal,
/// and a NaN would be rejected by HealthKit anyway.
public func healthSamples(for entry: LogEntryData) -> [HealthSample] {
    var samples: [HealthSample] = []
    if entry.totalCarbsG.isFinite, entry.totalCarbsG > 0 {
        samples.append(HealthSample(kind: .carbohydrates, value: entry.totalCarbsG, at: entry.eatenAt, externalId: entry.id))
    }
    if let taken = entry.takenUnits, taken.isFinite, taken > 0 {
        samples.append(HealthSample(kind: .insulinBolus, value: taken, at: entry.eatenAt, externalId: entry.id))
    }
    return samples
}
