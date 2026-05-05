// swift-tools-version: 5.9
// MindForest embedding sidecar.
//
// Single Swift Package that compiles to `mindforest-embed` — a small
// stdio JSON server the Rust `embed::SidecarEmbedder` spawns.
//
// Two build configurations, gated by an env var read at package-resolution
// time so the same source compiles in both:
//
// - Default ("stub"): no external dependencies; embeddings are
//   deterministic 768-d stub vectors derived from SHA-256 of the input.
//   Used for protocol-only validation, CI, and as a fallback when MLX
//   can't be linked.
// - `MINDFOREST_EMBED_MLX=1`: pulls in MLX-Swift + MLX-Swift-LM and
//   runs the real EmbeddingGemma 300M 4-bit pipeline. Apple Silicon only.
//
//     MINDFOREST_EMBED_MLX=1 swift build -c release
//
// The Swift flag `MLX_INFERENCE` propagates the choice into the source
// code (`#if MLX_INFERENCE`).

import PackageDescription

let useMLX = (Context.environment["MINDFOREST_EMBED_MLX"] ?? "0") == "1"

let mlxDeps: [Package.Dependency] = useMLX
  ? [
      .package(url: "https://github.com/ml-explore/mlx-swift", from: "0.21.2"),
      .package(url: "https://github.com/ml-explore/mlx-swift-lm", branch: "main"),
    ]
  : []

let mlxTargetDeps: [Target.Dependency] = useMLX
  ? [
      .product(name: "MLX", package: "mlx-swift"),
      .product(name: "MLXNN", package: "mlx-swift"),
      .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
      .product(name: "MLXEmbedders", package: "mlx-swift-lm"),
    ]
  : []

let mlxSwiftSettings: [SwiftSetting] = useMLX
  ? [.define("MLX_INFERENCE")]
  : []

let package = Package(
  name: "EmbedSidecar",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "mindforest-embed", targets: ["EmbedSidecar"]),
  ],
  dependencies: mlxDeps,
  targets: [
    .executableTarget(
      name: "EmbedSidecar",
      dependencies: mlxTargetDeps,
      swiftSettings: mlxSwiftSettings
    ),
  ]
)
