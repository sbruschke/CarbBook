import Foundation

/// Mirrors packages/core/src/imageStack.ts: which photos an overlapping stack draws, and in what
/// order. Layout, size and colour are the view's business; this decides only the ordering.
public enum ImageStack {
    /// Photos drawn per stack; same value as TS `IMAGE_STACK_MAX`.
    public static let max = 3
}

public struct StackEntry: Sendable {
    public var imageId: String?
    public var carbs: Double?

    public init(imageId: String?, carbs: Double?) {
        self.imageId = imageId
        self.carbs = carbs
    }
}

public struct StackLayout: Sendable, Equatable {
    /// Photos to draw, frontmost first.
    public var imageIds: [String]
    /// How many items in the group those photos do not account for.
    public var overflow: Int

    public init(imageIds: [String], overflow: Int) {
        self.imageIds = imageIds
        self.overflow = overflow
    }
}

/// The item driving the insulin dose is the one worth recognising first, so the biggest carbohydrate
/// contribution goes frontmost. Items with no image still count towards the overflow badge — they
/// exist, they simply have nothing to show (a food without a photo, or a quick-carb row that
/// references no food at all).
public func imageStackLayout(_ entries: [StackEntry], max maxPhotos: Int = ImageStack.max) -> StackLayout {
    // Carry the original index: Swift's sort is not stable, and the stack must not jitter between
    // renders when nothing has changed.
    let withImage = entries.enumerated()
        .filter { _, entry in
            guard let id = entry.imageId else { return false }
            return !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        .sorted { a, b in
            // An incomplete food still has an image worth showing, so unknown carbs sort last
            // rather than being hidden.
            let aKnown = (a.element.carbs?.isFinite ?? false)
            let bKnown = (b.element.carbs?.isFinite ?? false)
            if aKnown, bKnown, a.element.carbs != b.element.carbs { return a.element.carbs! > b.element.carbs! }
            if aKnown != bKnown { return aKnown }
            return a.offset < b.offset
        }

    // The id is a content hash used as a URL path, so it is passed through as stored.
    let imageIds = withImage.prefix(Swift.max(0, maxPhotos)).map { $0.element.imageId! }
    return StackLayout(imageIds: imageIds, overflow: Swift.max(0, entries.count - imageIds.count))
}
