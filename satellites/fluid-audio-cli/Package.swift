// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "KyberionFluidAudioBridge",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "fluidaudio-bridge", targets: ["FluidAudioBridge"]),
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.12.4"),
    ],
    targets: [
        .executableTarget(
            name: "FluidAudioBridge",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        ),
    ]
)
