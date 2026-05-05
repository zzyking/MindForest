# mindforest-embed

Stdio JSON sidecar for the MindForest embedding pipeline. The Rust
`embed::SidecarEmbedder` spawns this binary and talks to it over a
single newline-delimited JSON pipe.

## Build

Default ("stub") build — no external dependencies, deterministic
SHA-256-derived 768-d unit vectors. Useful for protocol validation and
as a fallback when MLX isn't linked:

```bash
cd rust/apps/embed-sidecar
swift build -c release
# binary at .build/release/mindforest-embed
```

The binary is also produced under `.build/<host-triple>/release/`
on Apple Silicon, which is what the Rust desktop shell looks for.

## Wire protocol

```text
→ {"id":1,"cmd":"health"}
← {"id":1,"ok":true,"model":"<name>","dim":768}

→ {"id":2,"texts":["text one","text two"]}
← {"id":2,"embeddings":[[768 floats], [768 floats]]}

→ {"id":0,"cmd":"shutdown"}      # graceful exit, the supervisor closes stdin
```

Lines are UTF-8 JSON, terminated by `\n`. Replies echo the request
`id`. `error` and `embeddings` are mutually exclusive in embed replies;
any backend failure becomes `{"id":N,"error":"..."}` rather than an
exit. Catastrophic protocol drift (parse failure, write failure)
exits non-zero so the Rust supervisor's exponential-backoff restart
fires.

## MLX inference (follow-up)

The default build is "stub" only. The real EmbeddingGemma 300M 4-bit
inference path lives behind the `MLX_INFERENCE` Swift compile flag and
the `MINDFOREST_EMBED_MLX=1` env var:

```bash
MINDFOREST_EMBED_MLX=1 swift build -c release
```

This pulls in `mlx-swift` and `mlx-swift-lm` (heavy deps; first build
takes minutes) and links MLXEmbedders to load
[`mlx-community/embeddinggemma-300m-4bit`](https://huggingface.co/mlx-community/embeddinggemma-300m-4bit).
The model is loaded lazily on first `embed` request.

The inference code itself is a follow-up commit — verifying MLX-
Swift-LM 3.x's `EmbedderModelFactory` API against the real Gemma3
weights requires hardware + the model in cache, which isn't free to
do in a code-review pass.

## Running standalone

You can poke the binary from the shell:

```bash
printf '{"id":1,"cmd":"health"}\n{"id":2,"texts":["hello"]}\n{"id":3,"cmd":"shutdown"}\n' \
  | ./.build/release/mindforest-embed
```

You should see two reply lines on stdout (health + embed) and a
startup message on stderr.

## Wiring into the API

Run the Rust API with the sidecar as the embed backend:

```bash
MINDFOREST_EMBED_MODE=sidecar \
  MINDFOREST_EMBED_BIN="$(pwd)/.build/release/mindforest-embed" \
  MINDFOREST_VAULT=/tmp/mf-vault \
  cargo run -p api
```

`/v1/index/status` will report `embed_available: true` once the
supervisor's health check completes (typically <1 s after the API
binds).

The desktop shell auto-resolves the sidecar binary in dev (looks for
`rust/apps/embed-sidecar/.build/<triple>/release/mindforest-embed`
relative to the workspace root) and falls back to the `Stub` Rust
embedder if it can't find a built binary.
