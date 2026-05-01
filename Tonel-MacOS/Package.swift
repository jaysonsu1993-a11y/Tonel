// swift-tools-version:6.0
//
// SwiftPM target — for typecheck / dev builds only. The real ship build is
// the Xcode project produced by `xcodegen generate` (uses Resources/Info.plist
// and entitlements). This package compiles all sources but does not bundle
// resources, sign, or set the Info.plist needed for mic permission at runtime.
import PackageDescription

let package = Package(
    name: "TonelMacOS",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "TonelMacOS", targets: ["TonelMacOS"])
    ],
    targets: [
        .executableTarget(
            name: "TonelMacOS",
            path: "TonelMacOS",
            exclude: ["Resources/Info.plist",
                      "Resources/TonelMacOS.entitlements"],
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ]
        )
    ]
)
