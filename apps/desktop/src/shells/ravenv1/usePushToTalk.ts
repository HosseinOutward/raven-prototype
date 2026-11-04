import { useCallback, useEffect, useRef, useState } from "react";
import { audioCommands } from "@/lib/audio";
import {
  pushToTalkCommands,
  subscribePushToTalkState,
  type PushToTalkSettings,
  type PushToTalkSettingsPatch,
} from "@/lib/pushToTalk";

export interface PushToTalkControls {
  settings: PushToTalkSettings | null;
  update: (patch: PushToTalkSettingsPatch) => Promise<void>;
}

/**
 * Push to talk's settings and whether the key is down. The gate itself lives in the engine;
 * this only reflects it. `cueAllowed` is false while a mute makes the key do nothing.
 */
export function usePushToTalk(cueAllowed = false): PushToTalkControls {
  const [settings, setSettings] = useState<PushToTalkSettings | null>(null);
  const cueAllowedRef = useRef(cueAllowed);
  cueAllowedRef.current = cueAllowed;
  const talkingRef = useRef(false);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    pushToTalkCommands
      .getSettings()
      .then((next) => {
        if (!active) return;
        talkingRef.current = next.talking;
        setSettings(next);
      })
      .catch(() => undefined);
    subscribePushToTalkState((next) => {
      if (!active) return;
      if (next.talking !== talkingRef.current && next.cue && cueAllowedRef.current) {
        void audioCommands.playSoundCue(next.talking ? "unmute" : "mute").catch(() => undefined);
      }
      talkingRef.current = next.talking;
      setSettings(next);
    })
      .then((nextUnlisten) => {
        if (active) unlisten = nextUnlisten;
        else nextUnlisten();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const update = useCallback(async (patch: PushToTalkSettingsPatch) => {
    setSettings(await pushToTalkCommands.updateSettings(patch));
  }, []);

  return { settings, update };
}

export function pushToTalkErrorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Raven could not change push to talk.";
}

/** Turning the mode on without a key goes through picking one first. */
export function usePushToTalkPicker({ settings, update }: PushToTalkControls) {
  const [listening, setListeningState] = useState(false);
  const [error, setError] = useState("");
  const enableOnPickRef = useRef(false);

  const setListening = useCallback((next: boolean) => {
    if (!next) enableOnPickRef.current = false;
    setListeningState(next);
  }, []);

  const apply = useCallback((patch: PushToTalkSettingsPatch) => {
    setError("");
    update(patch).catch((err) => setError(pushToTalkErrorMessage(err)));
  }, [update]);

  const setEnabled = useCallback((enabled: boolean) => {
    if (enabled && !settings?.key) {
      enableOnPickRef.current = true;
      setListeningState(true);
      return;
    }
    apply({ enabled });
  }, [apply, settings?.key]);

  const pick = useCallback((key: string) => {
    apply(enableOnPickRef.current ? { key, enabled: true } : { key });
  }, [apply]);

  return { listening, setListening, setEnabled, pick, apply, error: error || settings?.error || "" };
}
