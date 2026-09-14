import Foundation

/// UUIDv7 (RFC 9562) as lowercase text: 48-bit Unix ms, version 7, 74 random bits.
/// Ids sort by creation time, which the spec's §3 `id` column expects.
public enum UUIDv7 {
    private static let hex = Array("0123456789abcdef")

    public static func make<R: RandomNumberGenerator>(nowMs: Int64, using rng: inout R) -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        let ms = UInt64(max(0, nowMs)) & 0xFFFF_FFFF_FFFF
        for i in 0..<6 { bytes[i] = UInt8(truncatingIfNeeded: ms >> (UInt64(5 - i) * 8)) }
        let high: UInt64 = rng.next()
        let low: UInt64 = rng.next()
        for i in 6..<14 { bytes[i] = UInt8(truncatingIfNeeded: high >> (UInt64(i - 6) * 8)) }
        for i in 14..<16 { bytes[i] = UInt8(truncatingIfNeeded: low >> (UInt64(i - 14) * 8)) }
        bytes[6] = (bytes[6] & 0x0F) | 0x70
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        var out = ""
        for (i, b) in bytes.enumerated() {
            if [4, 6, 8, 10].contains(i) { out.append("-") }
            out.append(hex[Int(b >> 4)])
            out.append(hex[Int(b & 0x0F)])
        }
        return out
    }

    public static func make(nowMs: Int64) -> String {
        var rng = SystemRandomNumberGenerator()
        return make(nowMs: nowMs, using: &rng)
    }
}
