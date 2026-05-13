#!/usr/bin/env bash
# Compile mlx.metallib from mlx-swift's bundled .metal kernel sources.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# mlx-swift's Package.swift declares the C++ MLX runtime but no Metal
# compile step — SwiftPM has no built-in Metal toolchain support. As a
# result, `swift build -c release` on a target that pulls in mlx-swift
# produces a binary that links cleanly, runs CPU paths, and then throws
# "Failed to load the default metallib" the instant a GPU kernel is
# requested.
#
# The mlx-swift maintainers' official answer is "open Package.swift in
# Xcode and ⌘+B" — Xcode auto-compiles the .metal sources. Useless for
# CLI-driven dev, CI, and (in our case) Tauri's `beforeBuildCommand`.
# So we do what Xcode would: take the .metal kernel sources straight
# out of the SwiftPM checkout, run them through `xcrun -sdk macosx
# metal -c` and `xcrun -sdk macosx metallib`, and write the resulting
# `mlx.metallib` into `.build/release/` next to the sidecar binary. At
# runtime, MLX's `load_default_library` (mlx/backend/metal/device.cpp)
# probes for `mlx.metallib` colocated with the executing binary first;
# that's our hook.
#
# PREREQUISITES
# -------------
#  1. Xcode.app installed and selectable via DEVELOPER_DIR (we default
#     to /Applications/Xcode.app/Contents/Developer).
#  2. The Metal Toolchain component installed inside Xcode:
#        xcodebuild -downloadComponent MetalToolchain
#     This is a one-time ~700 MB download as of Xcode 26. Without it,
#     `xcrun metal` errors with a hint message pointing here.
#  3. mlx-swift checkout populated under .build/checkouts/. This happens
#     automatically the first time `swift build` resolves dependencies,
#     so this script can be run unconditionally after a SwiftPM build.
#
# IDEMPOTENCY
# -----------
# Skip-if-fresh: if the output metallib is newer than every .metal
# source the script exits with a "up to date" message. Set FORCE=1 to
# rebuild unconditionally.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SIDECAR_DIR=$(cd "$HERE/.." && pwd)
BUILD_DIR="$SIDECAR_DIR/.build"
RELEASE_DIR="$BUILD_DIR/release"
METALLIB_OUT="$RELEASE_DIR/mlx.metallib"

MLX_CHECKOUT="$BUILD_DIR/checkouts/mlx-swift/Source/Cmlx/mlx"
KERNELS_DIR="$MLX_CHECKOUT/mlx/backend/metal/kernels"
if [[ ! -d "$KERNELS_DIR" ]]; then
  echo "build-metallib.sh: kernel sources not found at" >&2
  echo "  $KERNELS_DIR" >&2
  echo "Run 'MINDFOREST_EMBED_MLX=1 swift build -c release' first to" >&2
  echo "populate the mlx-swift checkout." >&2
  exit 1
fi

export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}

if ! xcrun -sdk macosx --find metal >/dev/null 2>&1; then
  echo "build-metallib.sh: Metal toolchain not found in" >&2
  echo "  $DEVELOPER_DIR" >&2
  echo "Install with:" >&2
  echo "  xcodebuild -downloadComponent MetalToolchain" >&2
  echo "(~700 MB one-time download)" >&2
  exit 1
fi

if [[ "${FORCE:-0}" != "1" && -f "$METALLIB_OUT" ]]; then
  # Recompile costs ~30s on M-series; cache the work when nothing under
  # kernels/ has moved.
  newest_src=$(find "$KERNELS_DIR" -name "*.metal" -newer "$METALLIB_OUT" -print -quit 2>/dev/null || true)
  if [[ -z "$newest_src" ]]; then
    echo "build-metallib.sh: $METALLIB_OUT is up to date"
    exit 0
  fi
fi

AIR_DIR=$(mktemp -d)
trap 'rm -rf "$AIR_DIR"' EXIT

# Flags mirror upstream's CMakeLists (mlx/backend/metal/kernels/CMakeLists.txt).
# -fno-fast-math is non-optional: several kernels rely on IEEE-754 NaN
# semantics and break under -ffast-math reordering.
METAL_FLAGS=(
  -x metal
  -Wall
  -fno-fast-math
  -Wno-c++17-extensions
  -Wno-c++20-extensions
  -I "$MLX_CHECKOUT"
)

echo "build-metallib.sh: compiling .metal kernels..."
count=0
while IFS= read -r -d '' src; do
  rel="${src#$KERNELS_DIR/}"
  # Flatten nested paths so all .air files live in one flat dir and
  # globbing works for the link step (steel/conv/kernels/foo.metal
  # → steel_conv_kernels_foo.air).
  out=$(printf '%s' "$rel" | tr '/' '_' | sed 's/\.metal$/.air/')
  xcrun -sdk macosx metal "${METAL_FLAGS[@]}" -c "$src" -o "$AIR_DIR/$out"
  count=$((count + 1))
done < <(find "$KERNELS_DIR" -name "*.metal" -print0 | sort -z)

mkdir -p "$RELEASE_DIR"
echo "build-metallib.sh: linking $count kernels into mlx.metallib..."
xcrun -sdk macosx metallib "$AIR_DIR"/*.air -o "$METALLIB_OUT"
size_h=$(ls -lh "$METALLIB_OUT" | awk '{print $5}')
echo "build-metallib.sh: produced $METALLIB_OUT ($size_h)"
