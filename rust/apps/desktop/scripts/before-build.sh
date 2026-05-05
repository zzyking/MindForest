#!/usr/bin/env bash
# Tauri `beforeBuildCommand` hook for `cargo tauri build`.
# Stages the embed sidecar binary into ../desktop/binaries/ (where
# tauri.conf.json::bundle.externalBin expects it) and then runs the
# frontend production build. `cargo tauri dev` doesn't go through this
# hook — dev resolves the sidecar directly out of the Swift .build dir
# (see desktop/src/main.rs::resolve_sidecar_binary).
#
# Tauri 2 sets cwd to the directory above the one holding tauri.conf.json
# (i.e. rust/apps/), per the fix in commit 67de5ad. Resolve everything
# off this script's own location so the hook doesn't depend on cwd.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DESKTOP_DIR=$(cd "$HERE/.." && pwd)
SIDECAR_DIR=$(cd "$DESKTOP_DIR/../embed-sidecar" && pwd)
REPO_ROOT=$(cd "$DESKTOP_DIR/../../.." && pwd)

echo "before-build.sh: staging sidecar..."
"$SIDECAR_DIR/scripts/stage-for-tauri.sh"

echo "before-build.sh: building frontend..."
cd "$REPO_ROOT"
npm run build
