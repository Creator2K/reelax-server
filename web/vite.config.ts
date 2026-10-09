import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    port: 5173,
    // 开发时把 /api 与 /ws 反代到后端，前端只用自己的源
    proxy: {
      "/api": { target: "http://127.0.0.1:8580", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8580", ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
