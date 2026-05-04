import { defineConfig } from "vite";
import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite config for the MindForest v2 frontend.
//
// - port 13000 keeps continuity with the v1 Next.js dev port so muscle
//   memory and any in-flight bookmarks still work.
// - `@/*` mirrors the v1 alias so the import shape stays familiar; the
//   matching tsconfig.json `paths` entry is what makes editors happy.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 13000,
    strictPort: true,
  },
  preview: {
    port: 13000,
    strictPort: true,
  },
});
