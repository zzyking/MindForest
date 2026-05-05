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

let embedder: Embedder = {
  // Future: select MLXEmbedder when MLX_INFERENCE is built and the
  // model directory is reachable. For now the stub is the only path.
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
