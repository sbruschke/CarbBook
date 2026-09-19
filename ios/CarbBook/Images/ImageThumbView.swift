import CarbBookKit
import SwiftUI

/// One image, or nothing at all. There is deliberately no placeholder silhouette and no error state:
/// an empty slot is quieter than a fake image, and a dangling `image_id` — or bytes the server no
/// longer has — must read as "no image", never as something broken. Images are decoration, so a
/// failure here is silence, not an alert.
struct ImageThumbView: View {
    @Environment(AppModel.self) private var app
    let imageID: String?
    var size: CGFloat = 40

    @State private var image: UIImage?

    var body: some View {
        // The frame is claimed only once there is something to draw, so a row without an image keeps
        // its old layout rather than reserving an empty square.
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: size / 6, style: .continuous))
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
