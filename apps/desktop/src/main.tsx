import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { StudioWindow } from "@/components/studio/StudioWindow";
import { VoiceOverlayWindow } from "@/components/VoiceOverlayWindow";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppCrashFallback } from "@/shells/ravenv1/RegionFallback";
import { installGlobalErrorLogging, logUiError } from "@/lib/diagnostics";
import { parseRoute } from "@/lib/route";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
// Persian and Arabic script, which Geist does not cover.
import "@fontsource-variable/vazirmatn";
import "@/styles.css";

const route = parseRoute();

installGlobalErrorLogging();

// A render error no boundary caught unmounts the whole tree and blanks the window; the
// boundaries below should make this rare, and the log says where it came from.
ReactDOM.createRoot(document.getElementById("root")!, {
  onUncaughtError: (error, info) => logUiError("uncaught render error", error, info.componentStack),
  onRecoverableError: (error, info) => logUiError("recoverable render error", error, info.componentStack),
}).render(
  <React.StrictMode>
    {route.kind === "studio" ? (
      <StudioWindow nestId={route.nestId} />
    ) : route.kind === "overlay" ? (
      <VoiceOverlayWindow />
    ) : (
      <ErrorBoundary name="window" fallback={() => <AppCrashFallback />}>
        <App />
      </ErrorBoundary>
    )}
  </React.StrictMode>,
);
