import path from "node:path";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import { defineConfig, mergeConfig } from "vite";
import desktopTailwind from "../tailwind.config";
import desktopConfig from "../vite.config";

// The official server unless the build names another. Not the repo's .env, which points at
// a local API a phone can't reach.
const apiUrl = process.env.VITE_RAVEN_API_URL ?? "https://mimir.rvn.bluehour.cloud";

// Desktop's config (the `@` alias, the client version, its Tailwind theme) with the web
// entry, server and output. Every Tauri module becomes the stub: web has no Tauri runtime.
export default defineConfig((env) =>
  mergeConfig(desktopConfig(env), {
    define: { "import.meta.env.VITE_RAVEN_API_URL": JSON.stringify(apiUrl) },
    root: __dirname,
    publicDir: false,
    // Relative paths, so the same build works in the Android app and under /app/ on the web.
    base: "./",
    resolve: { alias: [{ find: /^@tauri-apps\/.*$/, replacement: path.resolve(__dirname, "src/tauriStub.ts") }] },
    css: { postcss: { plugins: [tailwindcss({ ...desktopTailwind, content: [path.resolve(__dirname, "index.html"), path.resolve(__dirname, "src/**/*.tsx"), path.resolve(__dirname, "../src/**/*.{ts,tsx}")] }), autoprefixer()] } },
    build: { outDir: "dist", emptyOutDir: true },
    server: { port: 1421 },
  }),
);
