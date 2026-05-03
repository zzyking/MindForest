// MindForest embedding sidecar — placeholder.
//
// Phase 3 implementation:
//   - load mlx-community/embeddinggemma-300m-4bit via MLX-Swift
//   - newline-delimited JSON over stdio:
//       → {"id":"req-1","texts":["..."]}
//       ← {"id":"req-1","embeddings":[[768 floats], ...]}
//   - graceful shutdown on {"cmd":"shutdown"}
//   - mean-pool last hidden state, L2-normalize, return float32

import Foundation

FileHandle.standardError.write(
  "mindforest-embed placeholder; sidecar protocol lands in Phase 3.\n".data(using: .utf8)!
)
exit(0)
