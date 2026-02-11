import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: "src/frontend",
  build: {
    outDir: path.resolve(process.cwd(), "dist/frontend"),
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "http://localhost:8767",
        ws: true
      },
      "/api": {
        target: "http://localhost:8767"
      }
    }
  }
});
