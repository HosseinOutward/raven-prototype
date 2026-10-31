import { useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import { failureText } from "@/lib/chat/errors";
import { DEFAULT_SETTINGS } from "@/lib/chat/reducer";
import type { ChatStore } from "@/lib/chat/store";
import { SettingsHint, SettingsPage, SettingsRows, SettingsSection, SettingsToggleRow } from "@/shells/ravenv1/SettingsScaffold";
import { useChatSelector } from "@/shells/ravenv1/useChat";

/** Settings for text chat. They are about what other people can see of you. */
type ReadKey = "readDm" | "readGroup" | "readPrivateSpace" | "readPublicSpace";

const SWITCHES: Array<{ key: ReadKey; label: string; description: string }> = [
  { key: "readDm", label: "Direct messages", description: "Show when you’ve seen the last message in a direct message." },
  { key: "readGroup", label: "Groups", description: "Show when you’ve seen the last message in a group." },
  { key: "readPrivateSpace", label: "Private spaces", description: "Show when you’ve seen the last message in a nest of a private tree." },
  { key: "readPublicSpace", label: "Public spaces", description: "Show when you’ve seen the last message in a nest of a public tree." },
];

/** Settings for text chat. They are about what other people can see of you. */
export function ChatSettingsPage({ chat }: { chat: ChatStore | null }) {
  const stored = useChatSelector(chat, (state) => state.settings, DEFAULT_SETTINGS);
  const [values, setValues] = useState(stored);
  useEffect(() => setValues(stored), [stored]);

  if (!chat) {
    return (
      <SettingsPage title="Messages" description="The server you are connected to does not have text chat.">
        {null}
      </SettingsPage>
    );
  }

  const change = (key: ReadKey, next: boolean) => {
    setValues((current) => ({ ...current, [key]: next }));
    void chat.setReadSwitch(key, next).catch((failure) => {
      setValues(stored);
      toast({ title: failureText(failure, "Couldn’t save that setting."), tone: "error" });
    });
  };

  return (
    <SettingsPage title="Messages" description="What other people can see when you read and write.">
      <SettingsSection title="Seen by">
        <SettingsRows>
          {SWITCHES.map(({ key, label, description }) => (
            <SettingsToggleRow key={key} label={label} description={description} checked={values[key]} onChange={(next) => change(key, next)} />
          ))}
        </SettingsRows>
        <SettingsHint>
          Each switch works both ways: with one off, you aren’t shown to others there and you don’t see them either. Only the last message shows who has seen it. While you are set to Invisible, nobody is shown that you have read or are typing.
        </SettingsHint>
      </SettingsSection>
    </SettingsPage>
  );
}
