import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SettingsField,
  SettingsHint,
  SettingsSection,
  SettingsToggleRow,
} from "@/shells/ravenv1/SettingsScaffold";
import {
  DEFAULT_VOICE_OVERLAY_HOTKEY,
  VoiceOverlaySettings,
  formatHotkeyEvent,
  voiceOverlayCommands,
} from "@/lib/voiceOverlay";

export function VoiceOverlaySettingsPanel() {
  const [settings, setSettings] = useState<VoiceOverlaySettings | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [hotkey, setHotkey] = useState(DEFAULT_VOICE_OVERLAY_HOTKEY);
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
        setHotkey(nextSettings.hotkey || DEFAULT_VOICE_OVERLAY_HOTKEY);
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
      const nextSettings = await voiceOverlayCommands.updateSettings({ enabled, hotkey });
      setSettings(nextSettings);
      setEnabled(nextSettings.enabled);
      setHotkey(nextSettings.hotkey || DEFAULT_VOICE_OVERLAY_HOTKEY);
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
      description="A small always-on-top panel showing who is speaking in your active room. Toggle it with a global hotkey."
    >
      <SettingsToggleRow
        label="Show voice overlay"
        description="Keep a compact speaker panel on top of other windows."
        checked={enabled}
        onChange={setEnabled}
      />

      <SettingsField
        label="Toggle hotkey"
        hint="Focus the field and press a key combination to rebind the overlay toggle."
      >
        <div className="relative">
          <Keyboard className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            value={hotkey}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              event.preventDefault();
              const nextHotkey = formatHotkeyEvent(event);
              if (nextHotkey) setHotkey(nextHotkey);
            }}
          />
        </div>
      </SettingsField>

      {error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      ) : null}

      <div className="flex justify-end">
        <Button type="button" onClick={() => void save()} disabled={saving || !hotkey.trim()}>
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
