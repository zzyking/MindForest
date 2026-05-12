#!/usr/bin/env bash
# Stage the Swift-built embed sidecar (and its colocated mlx.metallib)
# into rust/apps/desktop/binaries/ with the file-name shape Tauri's
# `bundle.externalBin` expects: <name>-<rustc-host-triple>.
#
# Tauri 2 packaging copies each externalBin entry into the .app's
# Contents/MacOS/ directory, stripping the triple suffix. We rely on
# that to land both `mindforest-embed` and `mlx.metallib` next to the
# main desktop binary at runtime — mlx-swift's METAL_PATH is hardcoded
# to "default.metallib" / "mlx.metallib" relative to the executing
# binary, so colocation is non-negotiable.
#
# Idempotent. Skips swift build if the binary already exists and is
# newer than every Swift source under Sources/EmbedSidecar — passing
# FORCE=1 forces a rebuild. MLX inference is the default; pass
# MLX=0 to stage the stub-only build instead (useful for CI).

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SIDECAR_DIR=$(cd "$HERE/.." && pwd)
DESKTOP_DIR=$(cd "$HERE/../../desktop" && pwd)
STAGE_DIR="$DESKTOP_DIR/binaries"

mkdir -p "$STAGE_DIR"

# Map rustc target triple ↔ swift build dir. We trust rustc to know
# the host triple; on macOS this is `aarch64-apple-darwin` or
# `x86_64-apple-darwin`. The Swift toolchain spells the same arch
# differently in `.build/<triple>/release/`.
RUST_TRIPLE=$(rustc --print host-tuple 2>/dev/null || rustc -vV | awk '/^host:/ {print $2}')
case "$RUST_TRIPLE" in
  aarch64-apple-darwin) SWIFT_TRIPLE="arm64-apple-macosx" ;;
  x86_64-apple-darwin)  SWIFT_TRIPLE="x86_64-apple-macosx" ;;
  *)
    echo "stage-for-tauri.sh: unsupported host triple '$RUST_TRIPLE'" >&2
    echo "  (sidecar is macOS-only; declare it by hand if you really" >&2
    echo "   need a build for this target)" >&2
    exit 1
    ;;
esac

USE_MLX=${MLX:-1}
SWIFT_BUILD_DIR="$SIDECAR_DIR/.build/release"
BIN_SRC="$SWIFT_BUILD_DIR/mindforest-embed"
METALLIB_SRC="$SWIFT_BUILD_DIR/mlx.metallib"

needs_rebuild=0
if [[ "${FORCE:-0}" = "1" ]]; then
  needs_rebuild=1
elif [[ ! -x "$BIN_SRC" ]]; then
  needs_rebuild=1
elif [[ "$USE_MLX" = "1" && ! -f "$METALLIB_SRC" ]]; then
  # MLX path requires the metallib alongside the binary — if it's
  # missing the build either failed or was a stub-only run.
  needs_rebuild=1
else
  newest_src=$(find "$SIDECAR_DIR/Sources" "$SIDECAR_DIR/Package.swift" -type f -newer "$BIN_SRC" -print -quit 2>/dev/null || true)
  if [[ -n "$newest_src" ]]; then
    needs_rebuild=1
  fi
fi

if [[ "$needs_rebuild" = "1" ]]; then
  echo "stage-for-tauri.sh: building sidecar (MLX=$USE_MLX)..."
  pushd "$SIDECAR_DIR" >/dev/null
  if [[ "$USE_MLX" = "1" ]]; then
    DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer} \
      MINDFOREST_EMBED_MLX=1 swift build -c release
  else
    swift build -c release
  fi
  popd >/dev/null
fi

# Stage the binary. Tauri requires the triple suffix at this stage;
# it strips the suffix when it copies into Contents/MacOS/.
install -m 0755 "$BIN_SRC" "$STAGE_DIR/mindforest-embed-$RUST_TRIPLE"
echo "stage-for-tauri.sh: staged $STAGE_DIR/mindforest-embed-$RUST_TRIPLE"

METALLIB_DST="$STAGE_DIR/mlx.metallib-$RUST_TRIPLE"
if [[ "$USE_MLX" = "1" ]]; then
  if [[ ! -f "$METALLIB_SRC" ]]; then
    echo "stage-for-tauri.sh: expected $METALLIB_SRC after MLX build but it's missing" >&2
    exit 2
  fi
  # Stage metallib as a pseudo-binary so Tauri externalBin will copy it
  # next to the sidecar in Contents/MacOS/. Tauri only looks at file
  # name and exec bit when staging externalBin entries; the contents
  # don't need to be Mach-O.
  install -m 0755 "$METALLIB_SRC" "$METALLIB_DST"
  echo "stage-for-tauri.sh: staged $METALLIB_DST"
else
  # MLX=0 (stub) path. Tauri's `bundle.externalBin` in tauri.conf.json
  # still lists mlx.metallib unconditionally, so the file must exist
  # for `cargo build` to succeed even when the runtime won't read it.
  # Drop an empty placeholder with the exec bit set; the stub embedder
  # never touches it. Run `MLX=1 ./stage-for-tauri.sh` to replace this
  # with a real metallib before shipping or before exercising the MLX
  # inference path.
  if [[ ! -f "$METALLIB_DST" ]]; then
    : > "$METALLIB_DST"
    chmod 0755 "$METALLIB_DST"
    echo "stage-for-tauri.sh: staged empty placeholder $METALLIB_DST (MLX=0)"
  fi
fi
