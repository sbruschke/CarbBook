import CarbBookKit
import SwiftUI

/// Circles by default: the user reads these as profile icons, and circles overlap far more legibly
/// in an `ImageStackView`. Only an editor's own preview — where the image itself is the subject being
/// judged, rather than a label on a row — asks for the rounded rectangle.
enum ThumbShape {
    case circle
    case rounded
}

/// One image, or nothing at all. There is deliberately no placeholder silhouette and no error state:
/// an empty slot is quieter than a fake image, and a dangling `image_id` — or bytes the server no
/// longer has — must read as "no image", never as something broken. Images are decoration, so a
/// failure here is silence, not an alert.
struct ImageThumbView: View {
    @Environment(AppModel.self) private var app
    let imageID: String?
    var size: CGFloat = 40
    var shape: ThumbShape = .circle
    /// A rim in the surface colour, for stacks: overlapping circles otherwise merge into one blob.
    /// Drawn only around an image that actually loaded, so a missing photo leaves no empty ring.
    var rim: Color?

    @State private var image: UIImage?

    /// Clipping and the rim are applied against one concrete shape per case rather than a
    /// type-erased `AnyInsettableShape`, which needs iOS 18 — this app targets 17.
    @ViewBuilder
    private func shaped(_ image: UIImage) -> some View {
        let picture = Image(uiImage: image)
            .resizable()
            .aspectRatio(contentMode: .fill)
            .frame(width: size, height: size)
        switch shape {
        case .circle:
            picture.clipShape(Circle()).overlay { rimBorder(Circle()) }
        case .rounded:
            let box = RoundedRectangle(cornerRadius: size / 6, style: .continuous)
            picture.clipShape(box).overlay { rimBorder(box) }
        }
    }

    @ViewBuilder
    private func rimBorder<S: InsettableShape>(_ shape: S) -> some View {
        if let rim { shape.strokeBorder(rim, lineWidth: 2) }
    }

    var body: some View {
        // The frame is claimed only once there is something to draw, so a row without an image keeps
        // its old layout rather than reserving an empty square.
        //
        // The zero-sized `Color.clear` is load-bearing, not decoration: SwiftUI does not run `.task`
        // on a view whose body resolves to empty, so a `Group` holding only a false `if` never fires
        // the fetch below — the view renders nothing, therefore never loads an image, therefore goes
        // on rendering nothing. Keeping a real (if invisible, zero-sized) view in the else branch
        // guarantees the task runs while leaving every row's layout exactly as it was.
        Group {
            if let image {
                shaped(image)
            } else {
                Color.clear.frame(width: 0, height: 0)
            }
        }
        .task(id: imageID) {
            image = nil
            guard let imageID else { return }
            guard let url = try? await app.images.fileURL(for: imageID),
                  let data = try? Data(contentsOf: url), let decoded = UIImage(data: data) else { return }
            image = decoded
        }
    }
}
