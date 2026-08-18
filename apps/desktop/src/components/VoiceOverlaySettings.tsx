import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  SettingsField,
  SettingsHint,
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
      <SettingsSection title="Voice overlay">
        <SettingsHint>Checking availability…</SettingsHint>
      </SettingsSection>
    );
  }

  if (!settings.supported) {
    return (
      <SettingsSection title="Voice overlay" description="A small always-on-top panel showing who is speaking in your active room.">
        <SettingsHint>The voice overlay is available on Windows. It is not supported on this system.</SettingsHint>
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
    <SettingsSection
      title="Voice overlay"
      description="A small always-on-top panel showing who is speaking in your active room. Configure its global shortcut under Hotkeys."
    >
      <SettingsToggleRow
        label="Show voice overlay"
        description="Keep a compact speaker panel on top of other windows."
        checked={enabled}
        onChange={setEnabled}
      />

      <SettingsField label="Participant layout" hint="Choose a vertical list or a compact horizontal strip.">
        <Select value={layout} onValueChange={(value) => setLayout(value as VoiceOverlayLayout)}>
          <SelectTrigger className="rounded-xl border-border">
            <SelectValue>{layout === "horizontal" ? "Horizontal" : "Vertical"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="vertical">Vertical</SelectItem>
              <SelectItem value="horizontal">Horizontal</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </SettingsField>

      <SettingsToggleRow
        label="Show people's names"
        description={
          layout === "horizontal"
            ? "Names are always hidden in horizontal mode. Your vertical preference is preserved."
            : "Display each participant's name beside their avatar."
        }
        checked={showNames}
        disabled={layout === "horizontal"}
        onChange={setShowNames}
      />

      {error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      ) : null}

      <div className="flex justify-end">
        <Button type="button" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save overlay settings"}
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
