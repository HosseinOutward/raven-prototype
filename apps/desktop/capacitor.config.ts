import type { CapacitorConfig } from "@capacitor/cli";

// The optional Capacitor wrapper for the web client. Its web code and Android project are in web/; the CLI runs here,
// beside package.json.
export default {
  appId: "org.raven.mobile",
  appName: "Raven",
  webDir: "web/dist",
  android: { path: "web/android" },
  // The page is https://capacitor.localhost, as desktop's is https://tauri.localhost: the
  // server allows it by name (RAVEN_CORS_ALLOWED_ORIGINS).
  server: { hostname: "capacitor.localhost" },
} satisfies CapacitorConfig;
