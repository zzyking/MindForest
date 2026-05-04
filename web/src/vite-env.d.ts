/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the Rust API. Defaults to `http://127.0.0.1:8787` when
   * unset (dev binary). The Tauri shell injects an in-process port at
   * boot so the desktop build doesn't need a separate process.
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
