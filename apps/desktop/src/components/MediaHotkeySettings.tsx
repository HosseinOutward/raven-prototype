import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsField, SettingsHint, SettingsSection } from "@/shells/ravenv1/SettingsScaffold";
import {
  DEFAULT_MEDIA_HOTKEYS,
  mediaHotkeyCommands,
  type MediaHotkeySettings,
  type MediaHotkeySettingsPatch,
} from "@/lib/mediaHotkeys";
import {
  DEFAULT_VOICE_OVERLAY_HOTKEY,
  formatHotkeyEvent,
  type VoiceOverlaySettings,
  voiceOverlayCommands,
} from "@/lib/voiceOverlay";

type HotkeyDraft = MediaHotkeySettingsPatch & { voiceOverlay: string };

const DEFAULT_HOTKEY_DRAFT: HotkeyDraft = {
  ...DEFAULT_MEDIA_HOTKEYS,
  voiceOverlay: DEFAULT_VOICE_OVERLAY_HOTKEY,
};

const FIELDS: { id: keyof HotkeyDraft; label: string; hint: string }[] = [
  { id: "mic", label: "Microphone", hint: "Mute or unmute your microphone." },
  { id: "camera", label: "Camera", hint: "Turn your camera on or off." },
  { id: "deafen", label: "Stop hearing people", hint: "Silence everyone, or hear them again." },
  { id: "screenShare", label: "Screen share", hint: "Choose what to share, or stop sharing." },
  { id: "voiceOverlay", label: "Voice overlay", hint: "Show or hide the overlay." },
];

export function MediaHotkeySettingsPanel() {
  const [settings, setSettings] = useState<MediaHotkeySettings | null>(null);
  const [overlaySettings, setOverlaySettings] = useState<VoiceOverlaySettings | null>(null);
  const [draft, setDraft] = useState<HotkeyDraft>(DEFAULT_HOTKEY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([mediaHotkeyCommands.getSettings(), voiceOverlayCommands.getSettings()])
      .then(([next, nextOverlay]) => {
        if (!active) return;
        setSettings(next);
        setOverlaySettings(nextOverlay);
        setDraft({ ...pickBindings(next), voiceOverlay: nextOverlay.hotkey || DEFAULT_VOICE_OVERLAY_HOTKEY });
        setError(next.registrationError ?? nextOverlay.registrationError ?? "");
      })
      .catch((err) => {
        if (!active) return;
        setSettings({ supported: false, ...DEFAULT_MEDIA_HOTKEYS, registrationError: null });
        setOverlaySettings(null);
        setError(messageFromHotkeyError(err));
      });
    return () => { active = false; };
  }, []);

  if (!settings || !overlaySettings) {
    return <SettingsSection title="Shortcuts"><SettingsHint>Checking whether shortcuts work on this system…</SettingsHint></SettingsSection>;
  }

  if (!settings.supported) {
    return (
      <SettingsSection title="Shortcuts">
        <SettingsHint>{settings.unsupportedReason || "Background shortcuts are not available on this system yet."}</SettingsHint>
      </SettingsSection>
    );
  }

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const mediaPatch = pickMediaDraft(draft);
      const [next, nextOverlay] = await Promise.all([
        mediaHotkeyCommands.updateSettings(mediaPatch),
        voiceOverlayCommands.updateSettings({ hotkey: draft.voiceOverlay }),
      ]);
      setSettings(next);
      setOverlaySettings(nextOverlay);
      setDraft({ ...pickBindings(next), voiceOverlay: nextOverlay.hotkey || DEFAULT_VOICE_OVERLAY_HOTKEY });
      setError(next.registrationError ?? nextOverlay.registrationError ?? "");
    } catch (err) {
      setError(messageFromHotkeyError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="Shortcuts"
      description="Click a field, then press the keys you want."
    >
      <div className="grid gap-4 md:grid-cols-2">
        {FIELDS.map((field) => (
          <SettingsField key={field.id} label={field.label} hint={field.hint}>
            <div className="relative">
              <Keyboard className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
              <Input
                className="rv-mono cursor-default pl-9 text-small"
                value={draft[field.id]}
                readOnly
                aria-label={`${field.label} global hotkey`}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  event.preventDefault();
                  const hotkey = formatHotkeyEvent(event);
                  if (hotkey) setDraft((current) => ({ ...current, [field.id]: hotkey }));
                }}
              />
            </div>
          </SettingsField>
        ))}
      </div>

      {error ? <p role="alert" className="rounded-control bg-destructive/10 px-3 py-2 text-small text-destructive">{error}</p> : null}

      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={() => setDraft(DEFAULT_HOTKEY_DRAFT)} disabled={saving}>Restore defaults</Button>
        <Button type="button" onClick={() => void save()} disabled={saving || Object.values(draft).some((value) => !value.trim())}>
          {saving ? "Saving…" : "Save shortcuts"}
        </Button>
      </div>
    </SettingsSection>
  );
}

function pickMediaDraft(draft: HotkeyDraft): MediaHotkeySettingsPatch {
  return {
    mic: draft.mic,
    camera: draft.camera,
    deafen: draft.deafen,
    screenShare: draft.screenShare,
  };
}

function pickBindings(settings: MediaHotkeySettings): MediaHotkeySettingsPatch {
  return {
    mic: settings.mic,
    camera: settings.camera,
    deafen: settings.deafen,
    screenShare: settings.screenShare,
  };
}

function messageFromHotkeyError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && "message" in detail && typeof (detail as { message?: unknown }).message === "string") {
      return (detail as { message: string }).message;
    }
  }
  return "Could not save global media hotkeys";
}
