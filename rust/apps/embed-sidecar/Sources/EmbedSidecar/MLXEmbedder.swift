#if MLX_INFERENCE
// MLX-Swift inference path for the MindForest embed sidecar.
//
// Built into the binary when `MINDFOREST_EMBED_MLX=1` is set at
// `swift build` time (the flag is forwarded into source via the
// `MLX_INFERENCE` Swift setting in `Package.swift`). Not compiled into
// stub-only builds so CI / Linux / Intel Macs don't need the whole MLX
// toolchain.
//
// Responsibilities:
//   - Load `mlx-community/embeddinggemma-300m-4bit` from a local
//     directory (no network — `ModelDownloader` on the Rust side already
//     put the files there).
//   - Tokenize, run inference, return 768-d L2-normalized float vectors.
//   - Bridge MLXEmbedders' `async` API to the sidecar's synchronous
//     stdio loop via a single background actor + DispatchSemaphore.
//
// We take `EmbeddingModelOutput.pooledOutput` directly rather than
// routing through `context.pooling` — the `EmbeddingGemma` model in
// mlx-swift-lm 3.31.3 does mean pooling, a dense projection head, and
// L2 normalization inside `callAsFunction` itself. Running the external
// `Pooling` module on top would bypass the dense projection (it reads
// `hiddenStates`, not `pooledOutput`) and produce subtly wrong vectors.

import Foundation
import MLX
import MLXEmbedders
import MLXHuggingFace
import MLXLMCommon
import MLXNN
import Tokenizers

/// Real EmbeddingGemma 4-bit embedder. Constructing this synchronously
/// loads and evaluates model weights, which is the entire reason we
/// bumped the Rust-side health-check timeout from 5s to 30s — on an M1
/// with 4-bit weights cold-cached this is ~2-4s; on slower machines
/// it can brush 10s. The stdio loop doesn't move until init returns.
final class MLXEmbedder: Embedder {

  let dim: Int
  let modelName: String

  private let container: EmbedderModelContainer

  /// Loads the model synchronously. Blocks the calling thread until the
  /// weights are resident, the tokenizer is built, and a warmup
  /// inference succeeds — so any failure surfaces before the sidecar
  /// ever reports healthy.
  ///
  /// - Parameters:
  ///   - modelDirectory: absolute path to a directory containing the
  ///     MLX-format safetensors + tokenizer files.
  ///   - dim: expected embedding dimension (768 for EmbeddingGemma-300M).
  ///     Mismatch is a fatal init error rather than a runtime surprise.
  init(modelDirectory: URL, dim: Int) throws {
    self.dim = dim
    self.modelName = "embeddinggemma-300m-4bit"

    // Run the async load on a fresh task and block until it resolves.
    // A DispatchSemaphore is the cheapest async→sync bridge here; we
    // don't have a RunLoop to spin, and we genuinely want the thread
    // parked so the stdio loop doesn't advance until we're ready.
    //
    // Swift 6 strict concurrency: the detached task closure is
    // `sending`, so we can't let it capture a local `var`. A one-shot
    // `Box` lets the closure publish a result back across threads
    // without triggering Sendable warnings — semaphore ordering
    // guarantees the read is safe.
    let sem = DispatchSemaphore(value: 0)
    let slot = Box<Result<EmbedderModelContainer, Error>>()
    Task.detached(priority: .userInitiated) {
      do {
        let c = try await EmbedderModelFactory.shared.loadContainer(
          from: modelDirectory,
          using: #huggingFaceTokenizerLoader()
        )
        slot.value = .success(c)
      } catch {
        slot.value = .failure(error)
      }
      sem.signal()
    }
    sem.wait()

    switch slot.value! {
    case .success(let c):
      self.container = c
    case .failure(let err):
      throw err
    }

    // Warmup — first call also JIT-specializes kernels; doing it inside
    // init means the first real embed request doesn't pay the cost and
    // means we fail init (→ Rust falls back to stub) rather than fail
    // the first user embed call if something is structurally wrong.
    let warm = try self.embed(["warmup"])
    guard warm.first?.count == dim else {
      throw MLXEmbedderError.unexpectedDimension(got: warm.first?.count ?? 0, want: dim)
    }
  }

  /// Synchronous embed — blocks the caller until MLX returns. The
  /// sidecar's stdio loop is single-threaded by design (one request at
  /// a time over stdin), so we don't need concurrent dispatch here; a
  /// single semaphore is sufficient and keeps ordering trivial.
  func embed(_ texts: [String]) throws -> [[Float]] {
    if texts.isEmpty { return [] }

    let sem = DispatchSemaphore(value: 0)
    let slot = Box<Result<[[Float]], Error>>()
    // Swift 6.2's region isolation checker can't always follow
    // `let container = self.container` into a detached task, so we
    // capture via explicit capture list and skip the local binding.
    // The outer function is synchronous and returns only after the
    // semaphore signals, so `self` staying alive across the task is
    // guaranteed by the caller.
    Task.detached(priority: .userInitiated) { [container = self.container] in
      do {
        let vecs = try await Self.runInference(container: container, texts: texts)
        slot.value = .success(vecs)
      } catch {
        slot.value = .failure(error)
      }
      sem.signal()
    }
    sem.wait()
    return try slot.value!.get()
  }

  /// The actual MLX pipeline — lives outside the actor-isolated
  /// `perform` closure only to keep init's warmup call and embed()
  /// sharing a single implementation.
  private static func runInference(
    container: EmbedderModelContainer,
    texts: [String]
  ) async throws -> [[Float]] {
    try await container.perform { context in
      // Tokenize each input. `addSpecialTokens: true` matches the
      // reference sentence-transformers pipeline for Gemma — the BOS
      // token affects output slightly.
      let encoded = texts.map {
        context.tokenizer.encode(text: $0, addSpecialTokens: true)
      }
      let maxLen = encoded.map(\.count).max() ?? 1
      let padId = 0  // EmbeddingGemma pad_token_id per config.json

      var padded: [[Int32]] = []
      var mask: [[Int32]] = []
      padded.reserveCapacity(encoded.count)
      mask.reserveCapacity(encoded.count)
      for tokens in encoded {
        var row = tokens.map(Int32.init)
        var m = [Int32](repeating: 1, count: row.count)
        let padNeeded = maxLen - row.count
        if padNeeded > 0 {
          row.append(contentsOf: [Int32](repeating: Int32(padId), count: padNeeded))
          m.append(contentsOf: [Int32](repeating: 0, count: padNeeded))
        }
        padded.append(row)
        mask.append(m)
      }

      let inputIds = MLXArray(padded.flatMap { $0 }, [padded.count, maxLen])
      let attnMask = MLXArray(mask.flatMap { $0 }, [mask.count, maxLen])

      let output = context.model(
        inputIds,
        positionIds: nil,
        tokenTypeIds: nil,
        attentionMask: attnMask
      )

      // EmbeddingGemma already performs mean-pool + dense projection
      // + L2 normalize inside callAsFunction and returns that in
      // pooledOutput; skip context.pooling (see file header comment).
      guard let pooled = output.pooledOutput else {
        throw MLXEmbedderError.noPooledOutput
      }
      pooled.eval()

      var vectors: [[Float]] = []
      vectors.reserveCapacity(texts.count)
      for i in 0..<texts.count {
        let row = pooled[i].asArray(Float.self)
        vectors.append(row)
      }
      return vectors
    }
  }
}

enum MLXEmbedderError: Error, CustomStringConvertible {
  case noPooledOutput
  case unexpectedDimension(got: Int, want: Int)

  var description: String {
    switch self {
    case .noPooledOutput:
      return "model returned no pooledOutput — EmbeddingGemma expected"
    case .unexpectedDimension(let got, let want):
      return "expected \(want)-dim embeddings, got \(got)"
    }
  }
}

/// One-shot cross-thread slot used to publish a result out of a
/// detached Task back to a waiting DispatchSemaphore. The semaphore
/// enforces happens-before ordering between the write and the read,
/// so `@unchecked Sendable` is sound here even under strict Swift 6
/// concurrency — the compiler just can't prove it on its own.
private final class Box<T>: @unchecked Sendable {
  var value: T?
}

#endif
