import CarbBookCore
import CarbBookKit
import SwiftUI

/// The overlapping photo cluster drawn where several items collapse onto one row — a logged entry, a
/// planned slot, a meal without a photo of its own. Which photos, and in what order, is core's
/// decision (`imageStackLayout`): the biggest carbohydrate contribution goes frontmost, because that
/// is the item driving the dose. Mirrors web's `ImageStack`.
struct ImageStackView: View {
    /// How much of the photo behind each layer covers. At 55% enough of every photo stays visible to
    /// recognise it while the group still reads as one cluster rather than a row of separate icons.
    private static let overlap: CGFloat = 0.55

    let entries: [StackEntry]
    var size: CGFloat = 40
    /// Overrides the default "N items" spoken label.
    var label: String?

    private var layout: StackLayout { imageStackLayout(entries) }

    var body: some View {
        // Nothing to show draws nothing at all, exactly as a single missing thumbnail does: an empty
        // ring where a photo might one day be is noisier than a plain row.
        if layout.imageIds.isEmpty {
            EmptyView()
        } else {
            HStack(spacing: -size * Self.overlap) {
                ForEach(Array(layout.imageIds.enumerated()), id: \.offset) { index, imageID in
                    ImageThumbView(imageID: imageID, size: size, rim: Theme.rowBackground)
                        // The thumbnail claims no space until its bytes arrive, so the frame is held
                        // here instead: a list row must not reflow as photos decode.
                        .frame(width: size, height: size)
                        // The frontmost photo has to sit on top of the one behind it.
                        .zIndex(Double(layout.imageIds.count - index))
                }
                if layout.overflow > 0 {
                    // Items the photos do not account for, quick-carbs rows included: they exist,
                    // they simply have nothing to show.
                    Text("+\(layout.overflow)")
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        // Undoes the stack's negative spacing, which applies to this gap too.
                        .padding(.leading, size * Self.overlap + 4)
                }
            }
            // The photos are decoration and every row states its contents in text, so the cluster is
            // one element saying how many items it stands for rather than a run of unlabelled images.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label ?? "\(entries.count) items")
        }
    }
}
