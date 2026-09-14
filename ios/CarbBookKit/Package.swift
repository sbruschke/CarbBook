// swift-tools-version: 6.1
import PackageDescription

// CarbBook data layer: GRDB store, sync store, API client, USDA bundle, barcode lookup, sync
// coordinator. No UIKit/SwiftUI, so tests run with `swift test` on macOS and in the Linux container.
let package = Package(
    name: "CarbBookKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CarbBookKit", targets: ["CarbBookKit"]),
    ],
    dependencies: [
        .package(path: "../CarbBookCore"),
        .package(url: "https://github.com/groue/GRDB.swift", exact: "7.11.1"),
        .package(url: "https://github.com/apple/swift-crypto", "4.5.2"..<"5.0.0"),
    ],
    targets: [
        .target(
            name: "CarbBookKit",
            dependencies: [
                "CarbBookCore",
                .product(name: "GRDB", package: "GRDB.swift"),
                .product(name: "Crypto", package: "swift-crypto"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "CarbBookKitTests",
            dependencies: ["CarbBookKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
