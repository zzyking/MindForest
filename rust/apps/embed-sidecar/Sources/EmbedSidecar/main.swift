// MindForest embedding sidecar — entry point.
//
// Reads newline-delimited JSON from stdin, replies on stdout. The Rust
// `embed::SidecarEmbedder` supervisor spawns this binary and serializes
// requests over the pipe (one outstanding at a time, matched by `id`).
//
// Process lifecycle:
//   1. Pick an embedder. Default is `StubEmbedder` — protocol-correct,
//      no model dependency. With `MLX_INFERENCE` defined and a model
//      directory available, swap in `MLXEmbedder`.
//   2. Read lines from stdin until EOF.
//      - "health"    → reply with model + dim
//      - "shutdown"  → exit 0 cleanly
//      - "embed"     → reply with vectors (no `cmd` field == embed)
//   3. On any unrecoverable error the process exits non-zero so the
//      supervisor's restart logic kicks in.
//
// Logging: anything to stderr is fine and ends up in the app log; do
// NOT write debug text to stdout, as that's the JSON channel.

import Foundation

// Pick an embedder once at startup. Order of preference:
//
//   1. MLXEmbedder — only when both (a) the binary was built with
//      `MINDFOREST_EMBED_MLX=1` (so `MLX_INFERENCE` is defined here) and
//      (b) the Rust side pointed us at a directory that actually has
//      the model files. If construction throws (missing weights,
//      corrupt tokenizer, etc.) we log and fall back to the stub
//      rather than hanging the whole session.
//   2. StubEmbedder — deterministic 768-d vectors, protocol-compatible,
//      no model dependency. Used in CI, on Intel Macs, and any time
//      MLX init failed.
//
// MLX init is the slow path — it synchronously loads ~200MB of 4-bit
// weights and runs a warmup inference. This is intentional: the Rust
// supervisor waits (with a 30s budget) for the health reply, so doing
// the load before the first reply means callers never see an
// "available but broken" state.
let embedder: Embedder = {
  #if MLX_INFERENCE
  if let modelPath = ProcessInfo.processInfo.environment["MINDFOREST_MODEL_DIR"],
     !modelPath.isEmpty {
    let dir = URL(fileURLWithPath: modelPath, isDirectory: true)
    let configPath = dir.appendingPathComponent("config.json").path
    if FileManager.default.fileExists(atPath: configPath) {
      do {
        FileHandle.standardError.write(
          Data("mindforest-embed: loading MLX model from \(modelPath)\n".utf8)
        )
        let start = Date()
        let m = try MLXEmbedder(modelDirectory: dir, dim: 768)
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        FileHandle.standardError.write(
          Data("mindforest-embed: MLX ready in \(ms)ms\n".utf8)
        )
        return m
      } catch {
        FileHandle.standardError.write(
          Data("mindforest-embed: MLX load failed: \(error) — falling back to stub\n".utf8)
        )
      }
    } else {
      FileHandle.standardError.write(
        Data("mindforest-embed: no config.json at \(modelPath) — falling back to stub\n".utf8)
      )
    }
  } else {
    FileHandle.standardError.write(
      Data("mindforest-embed: MINDFOREST_MODEL_DIR unset — falling back to stub\n".utf8)
    )
  }
  #endif
  return StubEmbedder(dim: 768)
}()

let reader = LineReader()
let writer = StdoutWriter()
let decoder = JSONDecoder()

FileHandle.standardError.write(
  Data("mindforest-embed up; model=\(embedder.modelName) dim=\(embedder.dim)\n".utf8)
)

while let line = reader.readLine() {
  if line.isEmpty { continue }
  let request: Inbound
  do {
    request = try decoder.decode(Inbound.self, from: line)
  } catch {
    // Stdin is misaligned — bail so the supervisor restarts us. Writing
    // a structured error here would still leave the protocol corrupt.
    FileHandle.standardError.write(Data("bad input json: \(error)\n".utf8))
    exit(2)
  }

  switch request.cmd {
  case "health":
    do {
      try writer.write(HealthReply(
        id: request.id, ok: true, model: embedder.modelName, dim: embedder.dim))
    } catch {
      FileHandle.standardError.write(Data("write health: \(error)\n".utf8))
      exit(2)
    }
  case "shutdown":
    // Drain any pending stdout, then exit.
    exit(0)
  case .none:
    // No `cmd` and `texts` present → embed.
    let texts = request.texts ?? []
    let reply: EmbedReply
    do {
      let vectors = try embedder.embed(texts)
      reply = EmbedReply(id: request.id, embeddings: vectors, error: nil)
    } catch {
      reply = EmbedReply(id: request.id, embeddings: nil, error: "\(error)")
    }
    do {
      try writer.write(reply)
    } catch {
      FileHandle.standardError.write(Data("write embed: \(error)\n".utf8))
      exit(2)
    }
  case .some(let other):
    let reply = EmbedReply(
      id: request.id, embeddings: nil, error: "unknown command: \(other)")
    try? writer.write(reply)
  }
}

// EOF on stdin — graceful exit.
exit(0)
