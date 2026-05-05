// Embedder abstraction. The default ("stub") build is the only one
// compiled in on this commit; the real `MLXEmbedder` lands behind
// `#if MLX_INFERENCE` in a follow-up once the MLXEmbedders API path
// for EmbeddingGemma 300M 4-bit is fully validated against the real
// weights. Until then the stub keeps the spawn / stdio / restart
// pipeline exercised end-to-end.

import Foundation
import CryptoKit

protocol Embedder {
  /// Human-readable identifier surfaced in the health reply.
  var modelName: String { get }
  /// Output dimension. The Rust client checks this against its expected
  /// 768 and aborts the session if they mismatch.
  var dim: Int { get }

  /// Run inference on a batch of texts. Returns one vector per input,
  /// each of length `dim`. Throws on backend failure; the caller turns
  /// the throw into an `error` reply (no shutdown).
  func embed(_ texts: [String]) throws -> [[Float]]
}

// ─────────────────────────────────────────────────────────────────────
// StubEmbedder
// ─────────────────────────────────────────────────────────────────────

/// Deterministic 768-dim unit vectors derived from SHA-256 of the input.
///
/// Identical text → identical vector. Different text → effectively
/// orthogonal vectors. The vectors are NOT semantic; this is for
/// validating the spawn / stdio / restart pipeline end-to-end without a
/// real model loaded.
final class StubEmbedder: Embedder {
  let modelName = "stub-sha256"
  let dim: Int

  init(dim: Int = 768) {
    self.dim = dim
  }

  func embed(_ texts: [String]) throws -> [[Float]] {
    return texts.map { stubVector(for: $0, dim: dim) }
  }
}

private func stubVector(for text: String, dim: Int) -> [Float] {
  // Generate `dim * 4` bytes by hashing increasing counter || text and
  // concatenating. SHA-256 gives 32 bytes per hash, so 768*4 = 3072
  // bytes needs 96 hash invocations.
  let bytesNeeded = dim * 4
  var raw = Data(capacity: bytesNeeded)
  let textData = text.data(using: .utf8) ?? Data()
  var counter: UInt32 = 0
  while raw.count < bytesNeeded {
    var input = Data()
    var c = counter.littleEndian
    withUnsafeBytes(of: &c) { input.append(contentsOf: $0) }
    input.append(textData)
    let digest = SHA256.hash(data: input)
    raw.append(contentsOf: Array(digest))
    counter += 1
  }
  // Reinterpret each 4-byte chunk as little-endian u32, project to [-1, 1).
  var v = [Float](repeating: 0, count: dim)
  for i in 0..<dim {
    let off = i * 4
    let u = UInt32(raw[off])
      | UInt32(raw[off + 1]) << 8
      | UInt32(raw[off + 2]) << 16
      | UInt32(raw[off + 3]) << 24
    v[i] = (Float(u) / Float(UInt32.max)) * 2 - 1
  }
  // Normalize to unit length so cosine similarity ranks cleanly.
  let norm = sqrt(v.reduce(into: Float(0)) { $0 += $1 * $1 })
  if norm > 0 {
    for i in 0..<dim { v[i] /= norm }
  }
  return v
}
