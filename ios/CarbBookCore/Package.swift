// swift-tools-version: 6.0
import PackageDescription

// Pure CarbBook logic. Foundation only, so `swift test` runs on macOS and Linux alike.
let package = Package(
    name: "CarbBookCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CarbBookCore", targets: ["CarbBookCore"]),
    ],
    targets: [
        .target(name: "CarbBookCore"),
        .testTarget(
            name: "CarbBookCoreTests",
            dependencies: ["CarbBookCore"],
            resources: [.copy("Resources")]
        ),
    ]
)
