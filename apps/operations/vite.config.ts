import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {"@": path.resolve(__dirname, "./src")},
  },
  server: {
    host: "127.0.0.1",
    port: 1430,
    strictPort: true,
    proxy: {
      "/v1": "http://127.0.0.1:6977",
      "/healthz": "http://127.0.0.1:6977",
    },
  },
});
