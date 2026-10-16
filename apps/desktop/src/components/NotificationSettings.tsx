import { useEffect, useState } from "react";
import { SettingsHint, SettingsRows, SettingsToggleRow } from "@/shells/ravenv1/SettingsScaffold";
import { loadNotificationSettings, notificationCommands, saveNotificationSettings, type NotificationSettings } from "@/lib/notifications";

export function NotificationSettingsPanel() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<NotificationSettings>(() => loadNotificationSettings());

  useEffect(() => {
    let active = true;
    notificationCommands
      .supported()
      .then((next) => {
        if (active) setSupported(next);
      })
      .catch(() => {
        if (active) setSupported(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (supported === null) return null;
  if (!supported) return <SettingsHint>Notifications work on Windows only for now.</SettingsHint>;

  const setKnocks = (knocks: boolean) => {
    const next = { ...settings, knocks };
    setSettings(next);
    saveNotificationSettings(next);
  };

  return (
    <SettingsRows>
      <SettingsToggleRow
        label="Knocks"
        description="Show a Windows notification when someone knocks on you while Raven is in the background. Do not disturb silences it."
        checked={settings.knocks}
        onChange={setKnocks}
      />
    </SettingsRows>
  );
}
