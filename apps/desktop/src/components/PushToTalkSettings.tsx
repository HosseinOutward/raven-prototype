import { PushToTalkKeyField } from "@/components/PushToTalkKeyField";
import { SettingsRow, SettingsRows, SettingsSection, SettingsToggleRow } from "@/shells/ravenv1/SettingsScaffold";
import { usePushToTalk, usePushToTalkPicker } from "@/shells/ravenv1/usePushToTalk";

/** The mode, its key and its sound. Everything here applies as soon as it changes. */
export function PushToTalkSettings() {
  const pushToTalk = usePushToTalk();
  const picker = usePushToTalkPicker(pushToTalk);
  const { settings } = pushToTalk;
  if (!settings) return null;
  const isWindows = /Win/i.test(navigator.platform);
  return (
    <SettingsSection title="Push to talk" description="Stay silent in a call until you hold a key. People see someone not speaking, not someone muted.">
      <SettingsRows>
        <SettingsToggleRow
          label="Use push to talk"
          description={settings.supported ? "Muting still wins: while you are muted, the key does nothing." : settings.unsupportedReason ?? undefined}
          checked={settings.enabled || (picker.listening && !settings.key)}
          disabled={!settings.supported}
          onChange={picker.setEnabled}
        />
        {settings.supported && (settings.enabled || picker.listening) ? (
          <SettingsRow
            label="Key"
            description={`Any key or mouse button, except left and right click.${isWindows ? " A game running as administrator can hide your key from Raven." : ""}`}
            control={(
              <div className="w-56">
                <PushToTalkKeyField value={settings.key} listening={picker.listening} onListeningChange={picker.setListening} onPick={picker.pick} />
              </div>
            )}
          />
        ) : null}
        {settings.supported && settings.enabled ? (
          <SettingsToggleRow label="Play a sound when you press and release" checked={settings.cue} onChange={(cue) => picker.apply({ cue })} />
        ) : null}
      </SettingsRows>
      {picker.error ? <p role="alert" className="text-small text-destructive">{picker.error}</p> : null}
    </SettingsSection>
  );
}
