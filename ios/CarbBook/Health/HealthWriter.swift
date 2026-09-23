import CarbBookCore
import CarbBookKit
import Foundation
import HealthKit

/// Writes a saved log entry's carbs and taken insulin to Apple Health (spec §1).
///
/// Everything here is mechanism: which samples exist is `healthSamples(for:)`, and whether an entry
/// was already written is `HealthLedger`. A failure is recorded in `lastStatus` and never thrown to
/// the caller — the CarbBook log is the record of truth, and a Health problem must not fail a save.
@MainActor
@Observable
final class HealthWriter {
    /// The Settings switch. Off by default: writing to Health is opt-in.
    private(set) var enabled: Bool
    /// One line describing the last attempt, shown under the Settings switch.
    private(set) var lastStatus: String?

    private let store = HKHealthStore()
    private let defaults: UserDefaults
    private let ledger: HealthLedger

    private static let enabledKey = "health.writeEnabled"
    private static let ledgerKey = "health.writtenEntryIds"
    private static let statusKey = "health.lastStatus"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        enabled = defaults.bool(forKey: Self.enabledKey)
        lastStatus = defaults.string(forKey: Self.statusKey)
        ledger = HealthLedger(
            load: { defaults.stringArray(forKey: Self.ledgerKey) ?? [] },
            store: { defaults.set($0, forKey: Self.ledgerKey) })
    }

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    private var types: Set<HKSampleType> { [HKQuantityType(.dietaryCarbohydrates), HKQuantityType(.insulinDelivery)] }

    /// Turning the switch on asks for authorization first; a refusal leaves the switch off, so the
    /// UI never claims to be writing when it cannot.
    ///
    /// iOS deliberately does not say whether *write* permission was granted — `requestAuthorization`
    /// succeeds either way, and a denied type silently drops its samples. So "on" here means the
    /// sheet was answered, not that Health is definitely taking the data; the first real write is
    /// what proves it, which is why `lastStatus` reports every attempt.
    func setEnabled(_ on: Bool) async {
        guard on else {
            enabled = false
            defaults.set(false, forKey: Self.enabledKey)
            record("Health writing is off.")
            return
        }
        guard isAvailable else {
            record("Apple Health is not available on this device.")
            return
        }
        do {
            try await store.requestAuthorization(toShare: types, read: [])
            enabled = true
            defaults.set(true, forKey: Self.enabledKey)
            record("Health writing is on. New entries will be added as you log them.")
        } catch {
            record("Health permission was not granted: \(error.localizedDescription)")
        }
    }

    /// Called after a log entry is saved. Silent and cheap when the feature is off.
    func write(_ entry: LogEntryData) async {
        guard enabled, isAvailable else { return }
        guard !ledger.wasWritten(entry.id) else { return }
        let samples = healthSamples(for: entry).map(hkSample)
        guard !samples.isEmpty else { return }
        do {
            try await store.save(samples)
            ledger.markWritten(entry.id)
            record("Last write: \(describe(samples.count)) at \(Date().formatted(date: .omitted, time: .shortened)).")
        } catch {
            record("Last write failed: \(error.localizedDescription)")
        }
    }

    private func hkSample(_ sample: HealthSample) -> HKQuantitySample {
        let at = Date(timeIntervalSince1970: Double(sample.at) / 1000)
        var metadata: [String: Any] = [HKMetadataKeyExternalUUID: sample.externalId]
        let type: HKQuantityType
        let quantity: HKQuantity
        switch sample.kind {
        case .carbohydrates:
            type = HKQuantityType(.dietaryCarbohydrates)
            quantity = HKQuantity(unit: .gram(), doubleValue: sample.value)
        case .insulinBolus:
            type = HKQuantityType(.insulinDelivery)
            quantity = HKQuantity(unit: .internationalUnit(), doubleValue: sample.value)
            metadata[HKMetadataKeyInsulinDeliveryReason] = HKInsulinDeliveryReason.bolus.rawValue
        }
        return HKQuantitySample(type: type, quantity: quantity, start: at, end: at, metadata: metadata)
    }

    private func describe(_ count: Int) -> String { count == 1 ? "1 sample" : "\(count) samples" }

    private func record(_ status: String) {
        lastStatus = status
        defaults.set(status, forKey: Self.statusKey)
    }
}
