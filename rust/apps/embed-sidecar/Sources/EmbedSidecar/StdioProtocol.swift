// Wire types for the stdio JSON protocol the Rust `SidecarEmbedder`
// expects. Mirrors the spec in `rust/crates/embed/src/sidecar.rs`:
//
//     → {"id":1,"cmd":"health"}
//     ← {"id":1,"ok":true,"model":"<name>","dim":768}
//
//     → {"id":2,"texts":["text1","text2"]}
//     ← {"id":2,"embeddings":[[…768 floats…], …]}
//
//     → {"id":0,"cmd":"shutdown"}     // graceful exit
//
// Errors are reported by attaching `"error": <string>` to the reply
// instead of `"embeddings"`. The Rust side surfaces these to callers.

import Foundation

/// A single inbound message. The `cmd` field discriminates between the
/// supported commands; absence of `cmd` (and presence of `texts`) means
/// "embed". This shape matches the Rust client which doesn't always set
/// `cmd` for the embed path.
struct Inbound: Decodable {
  let id: UInt64
  let cmd: String?
  let texts: [String]?
}

/// A reply to a `health` command.
struct HealthReply: Encodable {
  let id: UInt64
  let ok: Bool
  let model: String
  let dim: Int
}

/// A reply to an `embed` command. `error` is mutually exclusive with
/// `embeddings` — set the one that fits the outcome.
struct EmbedReply: Encodable {
  let id: UInt64
  let embeddings: [[Float]]?
  let error: String?
}

enum ProtocolError: Error, CustomStringConvertible {
  case malformedJSON(String)
  case unknownCommand(String)

  var description: String {
    switch self {
    case .malformedJSON(let s): return "malformed JSON: \(s)"
    case .unknownCommand(let s): return "unknown command: \(s)"
    }
  }
}

/// Buffered line-oriented stdin reader. Returns `nil` on EOF.
///
/// We don't use `readLine()` from stdlib because it returns Strings and
/// we want raw bytes (the JSON may include UTF-8 multibyte; readLine is
/// fine in practice but explicit is better).
final class LineReader {
  private let handle: FileHandle
  private var buffer = Data()

  init(_ handle: FileHandle = FileHandle.standardInput) {
    self.handle = handle
  }

  func readLine() -> Data? {
    while true {
      if let nl = buffer.firstIndex(of: 0x0A) {
        let line = buffer.subdata(in: buffer.startIndex..<nl)
        buffer.removeSubrange(buffer.startIndex...nl)
        return line
      }
      let chunk = handle.availableData
      if chunk.isEmpty {
        // EOF.
        if buffer.isEmpty {
          return nil
        }
        let tail = buffer
        buffer = Data()
        return tail
      }
      buffer.append(chunk)
    }
  }
}

/// Newline-flushed JSON writer for stdout.
final class StdoutWriter {
  private let handle: FileHandle = FileHandle.standardOutput
  private let encoder: JSONEncoder = {
    let e = JSONEncoder()
    // Keep replies compact — the Rust client parses lines as JSON; pretty
    // printing would just bloat the pipe.
    e.outputFormatting = []
    return e
  }()

  func write<T: Encodable>(_ value: T) throws {
    var data = try encoder.encode(value)
    data.append(0x0A) // '\n'
    handle.write(data)
  }
}
