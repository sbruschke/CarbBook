import CarbBookKit
import UIKit

/// Downscale-and-encode before upload so a 12MP photo never approaches the server's 5MB body limit.
/// The server re-encodes regardless: this is bandwidth, not validation. Always JPEG, because the
/// server's libvips cannot decode HEVC-based HEIC, which is what an iPhone camera produces.
///
/// It lives in the app target, not CarbBookKit, because UIKit does not exist on Linux and the Kit's
/// tests run there. The scale rule it follows is `PhotoScale.targetSize`, which is tested; the
/// rendering itself is only exercised when CI builds for iOS.
enum PhotoEncoder {
    static func jpegBase64(_ image: UIImage, maxEdge: Double = PhotoScale.maxEdge, quality: CGFloat = 0.85) -> String? {
        let target = PhotoScale.targetSize(width: image.size.width, height: image.size.height, maxEdge: maxEdge)
        let size = CGSize(width: target.width, height: target.height)
        // Scale 1 so the rendered pixel size is exactly `size`: the default would multiply it by the
        // screen scale and undo the downscale on a Retina device.
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return rendered.jpegData(compressionQuality: quality)?.base64EncodedString()
    }
}
