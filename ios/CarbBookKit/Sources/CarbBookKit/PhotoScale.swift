import Foundation

/// Downscale maths for a photo upload. Only the arithmetic lives here, in plain `Double`s: the UIKit
/// re-encode that uses it cannot compile on Linux (nor can CoreGraphics), so keeping this apart is
/// what lets the rule itself be tested. See `CarbBook/Images/PhotoEncoder.swift` for the encode.
public enum PhotoScale {
    /// Longest edge after downscaling, matching the server's `IMAGE_MAX_EDGE_PX`. The server caps
    /// again at the same size; doing it here is bandwidth, not validation.
    public static let maxEdge: Double = 800

    /// The size to render at: at most `maxEdge` on its longest side, never upscaled (a small photo
    /// gains nothing from it and only costs bytes), and never smaller than one pixel either way.
    public static func targetSize(width: Double, height: Double, maxEdge: Double = maxEdge) -> (width: Double, height: Double) {
        let longest = max(width, height)
        guard longest > 0, longest.isFinite else { return (1, 1) }
        let scale = min(1, maxEdge / longest)
        return (max(1, (width * scale).rounded()), max(1, (height * scale).rounded()))
    }
}
