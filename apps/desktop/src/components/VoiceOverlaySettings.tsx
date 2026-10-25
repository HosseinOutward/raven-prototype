import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  SettingsChoice,
  SettingsHint,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsToggleRow,
} from "@/shells/ravenv1/SettingsScaffold";
import {
  DEFAULT_VOICE_OVERLAY_NAME_BACKGROUND,
  type VoiceOverlayLayout,
  type VoiceOverlayNameBackground,
  type VoiceOverlaySettings,
  voiceOverlayCommands,
} from "@/lib/voiceOverlay";

const NAME_BACKGROUND_LABEL: Record<VoiceOverlayNameBackground, string> = {
  off: "Off",
  light: "Light",
  strong: "Strong",
};

export function VoiceOverlaySettingsPanel() {
  const [settings, setSettings] = useState<VoiceOverlaySettings | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [layout, setLayout] = useState<VoiceOverlayLayout>("vertical");
  const [showNames, setShowNames] = useState(true);
  const [nameBackground, setNameBackground] = useState<VoiceOverlayNameBackground>(DEFAULT_VOICE_OVERLAY_NAME_BACKGROUND);
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
        setNameBackground(nextSettings.nameBackground ?? DEFAULT_VOICE_OVERLAY_NAME_BACKGROUND);
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
      const nextSettings = await voiceOverlayCommands.updateSettings({ enabled, layout, showNames, nameBackground });
      setSettings(nextSettings);
      setEnabled(nextSettings.enabled);
      setLayout(nextSettings.layout);
      setShowNames(nextSettings.showNames);
      setNameBackground(nextSettings.nameBackground ?? DEFAULT_VOICE_OVERLAY_NAME_BACKGROUND);
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
        <SettingsRow
          label="Name background"
          description={
            layout === "horizontal" || !showNames
              ? "Only applies when names are shown in the list."
              : "A dark fill behind each name, so it can be read over any game."
          }
          className={layout === "horizontal" || !showNames ? "opacity-55" : undefined}
          control={
            <Select
              value={nameBackground}
              disabled={layout === "horizontal" || !showNames}
              onValueChange={(value) => setNameBackground(value as VoiceOverlayNameBackground)}
            >
              <SelectTrigger size="sm" className="w-[112px]" aria-label="Name background">
                <SelectValue>{NAME_BACKGROUND_LABEL[nameBackground]}</SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="strong">Strong</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          }
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
