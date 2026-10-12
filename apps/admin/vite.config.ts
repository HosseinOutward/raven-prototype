import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The dashboard talks to the API on its own origin: in development through this proxy,
// in production through the dashboard host's reverse proxy. It never needs CORS.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    host: "127.0.0.1",
    port: 1440,
    strictPort: true,
    proxy: {
      "/v1": process.env.RAVEN_ADMIN_API_URL || "http://127.0.0.1:6977",
    },
  },
});
