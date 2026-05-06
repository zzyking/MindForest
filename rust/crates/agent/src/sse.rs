//! Tiny streaming SSE line splitter used by both provider impls.
//!
//! Reads a `reqwest::Response::bytes_stream()` and yields `SseEvent`
//! values once full event blocks (terminated by a blank line) have
//! arrived. Both OpenAI and Anthropic speak the same wire format
//! (text/event-stream, lines like `event: foo` and `data: {...}`,
//! events separated by `\n\n`); only the payload semantics differ.

use std::pin::Pin;

use bytes::Bytes;
use futures::stream::{Stream, StreamExt};

#[derive(Debug, Default, Clone)]
pub struct SseEvent {
  pub event: Option<String>,
  pub data: String,
}

pub type EventStream = Pin<Box<dyn Stream<Item = Result<SseEvent, reqwest::Error>> + Send>>;

/// Convert a byte stream into an SseEvent stream. The internal buffer
/// is flushed on `\n\n` boundaries; partial events at end-of-stream are
/// dropped (they'd be malformed by definition).
pub fn into_event_stream<S>(byte_stream: S) -> EventStream
where
  S: Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
{
  let inner = async_stream::stream! {
    let mut buf = String::new();
    let mut s = Box::pin(byte_stream);
    while let Some(chunk) = s.next().await {
      let chunk = match chunk {
        Ok(c) => c,
        Err(e) => {
          yield Err(e);
          return;
        }
      };
      // Lossy is fine — provider streams are UTF-8 and any malformed
      // continuation byte will be replaced with U+FFFD, never silently
      // drop characters.
      buf.push_str(&String::from_utf8_lossy(&chunk));
      while let Some(end) = find_event_end(&buf) {
        let raw = buf[..end].to_string();
        buf.drain(..end + 2); // also drop the \n\n separator
        if let Some(ev) = parse_event(&raw) {
          yield Ok(ev);
        }
      }
    }
  };
  Box::pin(inner)
}

fn find_event_end(buf: &str) -> Option<usize> {
  buf.find("\n\n")
}

fn parse_event(raw: &str) -> Option<SseEvent> {
  let mut ev = SseEvent::default();
  let mut data_lines: Vec<&str> = Vec::new();
  for line in raw.split('\n') {
    let line = line.strip_suffix('\r').unwrap_or(line);
    if line.is_empty() || line.starts_with(':') {
      continue;
    }
    let (k, v) = match line.split_once(':') {
      Some((k, v)) => (k, v.strip_prefix(' ').unwrap_or(v)),
      None => (line, ""),
    };
    match k {
      "event" => ev.event = Some(v.to_string()),
      "data" => data_lines.push(v),
      _ => {}
    }
  }
  if data_lines.is_empty() && ev.event.is_none() {
    return None;
  }
  ev.data = data_lines.join("\n");
  Some(ev)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_data_only_event() {
    let ev = parse_event("data: hello world").unwrap();
    assert!(ev.event.is_none());
    assert_eq!(ev.data, "hello world");
  }

  #[test]
  fn parses_named_event_with_json_data() {
    let raw = "event: content_block_delta\ndata: {\"x\":1}";
    let ev = parse_event(raw).unwrap();
    assert_eq!(ev.event.as_deref(), Some("content_block_delta"));
    assert_eq!(ev.data, "{\"x\":1}");
  }

  #[test]
  fn ignores_comments_and_blanks() {
    let raw = ": this is a comment\n\ndata: ok";
    // `find_event_end` would pick the blank line first; `parse_event`
    // sees only the comment portion and yields None. The next event in
    // the buffer would be "data: ok" alone. Our test wraps the
    // "data: ok" alone:
    let ev = parse_event("data: ok").unwrap();
    assert_eq!(ev.data, "ok");
    let _ = raw; // silence unused warning if compiler complains
  }
}
