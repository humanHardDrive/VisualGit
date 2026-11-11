/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Tauri expects a fixed dev-server port and does not want the console cleared.
export default defineConfig({
  // The tests build scratch repositories with dozens of git commands each, and
  // starting a process is slow on Windows: vitest's 5-second default is too tight there.
  test: { testTimeout: 30_000 },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "safari15",
    outDir: "dist",
    // Pages: the branch explorer, and the merge, changeset diff and submodule windows.
    rollupOptions: {
      input: { main: "index.html", merge: "merge.html", diff: "diff.html", submodule: "submodule.html", "submodule-pick": "submodule-pick.html" },
    },
  },
});
