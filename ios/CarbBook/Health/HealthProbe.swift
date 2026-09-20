import HealthKit

/// Temporary: proves a LiveContainer guest can reach HealthKit at all (spec §1, feasibility gate).
/// Deleted once HealthWriter replaces it.
enum HealthProbe {
    static func run() async -> String {
        guard HKHealthStore.isHealthDataAvailable() else { return "Health data is not available on this device." }
        let store = HKHealthStore()
        let carbs = HKQuantityType(.dietaryCarbohydrates)
        do {
            try await store.requestAuthorization(toShare: [carbs], read: [])
        } catch {
            return "Authorization failed: \(error.localizedDescription)"
        }
        let sample = HKQuantitySample(type: carbs,
                                      quantity: HKQuantity(unit: .gram(), doubleValue: 1),
                                      start: Date(), end: Date())
        do {
            try await store.save(sample)
            return "Wrote a 1 g test sample. Check Health › Browse › Nutrition › Carbohydrates."
        } catch {
            return "Write failed: \(error.localizedDescription)"
        }
    }
}
