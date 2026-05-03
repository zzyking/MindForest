// swift-tools-version: 5.9
// Placeholder Swift package for the MLX-Swift embedding sidecar.
// Real implementation (MLX-Swift + EmbeddingGemma 300M 4-bit, stdio JSON
// protocol, mean-pooled 768-d output) lands in Phase 3.

import PackageDescription

let package = Package(
  name: "EmbedSidecar",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "mindforest-embed", targets: ["EmbedSidecar"]),
  ],
  dependencies: [
    // .package(url: "https://github.com/ml-explore/mlx-swift", from: "0.18.0"),
    // .package(url: "https://github.com/apple/swift-argument-parser", from: "1.3.0"),
  ],
  targets: [
    .executableTarget(
      name: "EmbedSidecar",
      dependencies: [
        // .product(name: "MLX", package: "mlx-swift"),
        // .product(name: "MLXNN", package: "mlx-swift"),
        // .product(name: "ArgumentParser", package: "swift-argument-parser"),
      ]
    ),
  ]
)
