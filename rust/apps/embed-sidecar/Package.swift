// swift-tools-version: 6.1
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
// - `MINDFOREST_EMBED_MLX=1`: pulls in mlx-swift + mlx-swift-lm and runs
//   the real EmbeddingGemma 300M 4-bit inference pipeline. Apple Silicon
//   only; the runtime verifies that and falls back gracefully otherwise.
//
//     MINDFOREST_EMBED_MLX=1 swift build -c release
//
// The Swift flag `MLX_INFERENCE` propagates the choice into the source
// code (`#if MLX_INFERENCE`). Swift tools 6.1 is required by mlx-swift-lm.

import PackageDescription

let useMLX = (Context.environment["MINDFOREST_EMBED_MLX"] ?? "0") == "1"

// mlx-swift-lm 3.31.3 pins mlx-swift to `.upToNextMinor(from: "0.31.3")`.
// We list mlx-swift explicitly because SPM only exposes products declared
// in our direct dependencies — transitive products won't be visible.
// Matching the pin (same minor track) keeps version resolution trivial.
//
// mlx-swift-lm: pinned off-tag to the head commit of upstream PR #223
// (https://github.com/ml-explore/mlx-swift-lm/pull/223) until it merges.
// 3.31.3's `EmbeddingGemma.sanitize(weights:)` reassigns
// `_dense.wrappedValue = [...]` after `init` already seeded it, which
// trips `@ModuleInfo`'s init-order guard and aborts with
// `please use Model.update(modules:)`. The PR replaces the assignment
// with `update(modules: .unflattened([...]))` and also fixes a second
// latent bug — the dense head's hidden dim is read off
// `dense.0.weight.dim(0)` (4·hiddenSize = 3072 for embeddinggemma-300m)
// instead of `config.intermediateSize` (1152), which prevents a
// follow-up shape-mismatch on weight load.
//
// We host the pinned commit ourselves at `zzyking/mlx-swift-lm` on
// branch `mindforest-pin/embeddinggemma-pr223` rather than depending
// on the PR author's fork, so the upstream contributor can't pull the
// commit out from under us once their PR merges and they clean up.
// The branch is a verbatim push of `0xweb3r/mlx-swift-lm@16e8d1b4`
// — same SHA, no rewrites — so reviewers can diff against the PR.
//
// TODO: revert to `from: "<next tag>"` once PR #223 is merged and a
// new mlx-swift-lm release ships.
//
// swift-transformers is required by the `#huggingFaceTokenizerLoader()`
// macro: its expansion calls `Tokenizers.AutoTokenizer.from(modelFolder:)`
// and adapts the result via `#adaptHuggingFaceTokenizer`. We only use the
// local-directory path, so we don't need `HuggingFace.HubClient`.
let mlxDeps: [Package.Dependency] = useMLX
  ? [
      .package(
        url: "https://github.com/ml-explore/mlx-swift",
        .upToNextMinor(from: "0.31.3")
      ),
      .package(
        url: "https://github.com/zzyking/mlx-swift-lm",
        revision: "16e8d1b49ff5b214d8604cf1739016ee16a44081"
      ),
      .package(
        url: "https://github.com/huggingface/swift-transformers",
        from: "1.1.0"
      ),
    ]
  : []

let mlxTargetDeps: [Target.Dependency] = useMLX
  ? [
      .product(name: "MLX", package: "mlx-swift"),
      .product(name: "MLXNN", package: "mlx-swift"),
      .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
      .product(name: "MLXEmbedders", package: "mlx-swift-lm"),
      .product(name: "MLXHuggingFace", package: "mlx-swift-lm"),
      .product(name: "Tokenizers", package: "swift-transformers"),
    ]
  : []

let mlxSwiftSettings: [SwiftSetting] = useMLX
  ? [
      .define("MLX_INFERENCE"),
      // mlx-swift-lm 3.31.3 is not yet fully vetted against Swift 6.2's
      // strict region-based isolation checker; bridging its async
      // `EmbedderModelContainer` API to a sync stdio loop triggers a
      // "pattern ... does not understand how to check" false positive
      // in the checker. Drop the sidecar target back to the Swift 5
      // concurrency model — we still compile with tools 6.1 and get
      // the mlx-swift-lm dependency, just without the experimental
      // isolation pass.
      .swiftLanguageMode(.v5),
    ]
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
