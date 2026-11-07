import { defineConfig } from "vite";

// Tauri expects a fixed dev-server port and does not want the console cleared.
export default defineConfig({
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
    // Two pages: the branch explorer and the Pending Changes window.
    rollupOptions: { input: { main: "index.html", pending: "pending.html" } },
  },
});
