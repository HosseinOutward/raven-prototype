import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { StudioWindow } from "@/components/studio/StudioWindow";
import { VoiceOverlayWindow } from "@/components/VoiceOverlayWindow";
import { parseRoute } from "@/lib/route";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
// Persian and Arabic script, which Geist does not cover.
import "@fontsource-variable/vazirmatn";
import "@/styles.css";

const route = parseRoute();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {route.kind === "studio" ? (
      <StudioWindow nestId={route.nestId} />
    ) : route.kind === "overlay" ? (
      <VoiceOverlayWindow />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
