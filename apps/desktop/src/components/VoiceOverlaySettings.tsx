import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  SettingsChoice,
  SettingsHint,
  SettingsRows,
  SettingsSection,
  SettingsToggleRow,
} from "@/shells/ravenv1/SettingsScaffold";
import {
  type VoiceOverlayLayout,
  type VoiceOverlaySettings,
  voiceOverlayCommands,
} from "@/lib/voiceOverlay";

export function VoiceOverlaySettingsPanel() {
  const [settings, setSettings] = useState<VoiceOverlaySettings | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [layout, setLayout] = useState<VoiceOverlayLayout>("vertical");
  const [showNames, setShowNames] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    voiceOverlayCommands
      .getSettings()
      .then((nextSettings) => {
        if (!active) return;
        setSettings(nextSettings);
        setEnabled(nextSettings.enabled);
        setLayout(nextSettings.layout);
        setShowNames(nextSettings.showNames);
        setError(nextSettings.registrationError ?? "");
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (!settings) {
    return (
      <SettingsSection title="Overlay">
        <SettingsHint>Checking whether the overlay works on this system…</SettingsHint>
      </SettingsSection>
    );
  }

  if (!settings.supported) {
    return (
      <SettingsSection title="Overlay">
        <SettingsHint>The overlay works on Windows only for now.</SettingsHint>
      </SettingsSection>
    );
  }

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const nextSettings = await voiceOverlayCommands.updateSettings({ enabled, layout, showNames });
      setSettings(nextSettings);
      setEnabled(nextSettings.enabled);
      setLayout(nextSettings.layout);
      setShowNames(nextSettings.showNames);
      setError(nextSettings.registrationError ?? "");
    } catch (err) {
      setError(messageFromOverlayError(err));
      voiceOverlayCommands
        .getSettings()
        .then(setSettings)
        .catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Overlay" description="Its shortcut is set under Hotkeys.">
      <SettingsRows>
        <SettingsToggleRow
          label="Show the overlay during calls"
          description="A compact list of who is in the call, on top of other windows."
          checked={enabled}
          onChange={setEnabled}
        />
        <SettingsToggleRow
          label="Show names"
          description={layout === "horizontal" ? "The strip shows pictures only. This applies again when you switch back to the list." : "Each person’s name beside their picture."}
          checked={showNames}
          disabled={layout === "horizontal"}
          onChange={setShowNames}
        />
      </SettingsRows>

      <SettingsRows>
        <SettingsChoice title="List" copy="People stacked top to bottom." selected={layout === "vertical"} onSelect={() => setLayout("vertical" as VoiceOverlayLayout)} />
        <SettingsChoice title="Strip" copy="People side by side, pictures only." selected={layout === "horizontal"} onSelect={() => setLayout("horizontal" as VoiceOverlayLayout)} />
      </SettingsRows>

      {error ? (
        <p role="alert" className="rounded-control bg-destructive/10 px-3 py-2 text-small text-destructive">{error}</p>
      ) : null}

      <div className="flex justify-end">
        <Button type="button" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </SettingsSection>
  );
}

function messageFromOverlayError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail?: { message?: unknown } }).detail;
    if (detail && typeof detail.message === "string") return detail.message;
  }
  return "Could not save overlay settings";
}
