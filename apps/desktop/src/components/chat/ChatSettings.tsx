import { useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import { failureText } from "@/lib/chat/errors";
import type { ChatStore } from "@/lib/chat/store";
import { SettingsHint, SettingsPage, SettingsRows, SettingsSection, SettingsToggleRow } from "@/shells/ravenv1/SettingsScaffold";
import { useChatSelector } from "@/shells/ravenv1/useChat";

/** Settings for text chat. They are about what other people can see of you. */
export function ChatSettingsPage({ chat }: { chat: ChatStore | null }) {
  const stored = useChatSelector(chat, (state) => state.settings.shareReadStatus, true);
  const [share, setShare] = useState(stored);
  useEffect(() => setShare(stored), [stored]);

  if (!chat) {
    return (
      <SettingsPage title="Messages" description="The server you are connected to does not have text chat.">
        {null}
      </SettingsPage>
    );
  }

  const change = (next: boolean) => {
    setShare(next);
    void chat.setShareReadStatus(next).catch((failure) => {
      setShare(stored);
      toast({ title: failureText(failure, "Couldn’t save that setting."), tone: "error" });
    });
  };

  return (
    <SettingsPage title="Messages" description="What other people can see when you read and write.">
      <SettingsSection title="Read status">
        <SettingsRows>
          <SettingsToggleRow
            label="Show when you’ve read messages"
            description="In a direct message, each of you sees when the other has read. It works both ways: with this off, you don’t see theirs either."
            checked={share}
            onChange={change}
          />
        </SettingsRows>
        <SettingsHint>
          Groups never show who has read what. While you are set to Invisible, nobody is shown that you have read or are typing.
        </SettingsHint>
      </SettingsSection>
    </SettingsPage>
  );
}
