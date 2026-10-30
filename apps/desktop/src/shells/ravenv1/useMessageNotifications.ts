import { useEffect, useRef } from "react";
import { audioCommands } from "@/lib/audio";
import { subscribeMessageNotifications } from "@/lib/chat/messageNotifications";
import type { ChatStore } from "@/lib/chat/store";
import { loadNotificationSettings, notificationCommands } from "@/lib/notifications";
import type { RavenShellData, RavenView } from "./state";
import { useWindowActive } from "./useChat";

export function useMessageNotifications(chat: ChatStore | null, data: RavenShellData, view: RavenView) {
  const active = useWindowActive();
  const current = useRef({ userId: data.user?.id ?? "", dnd: data.presence?.state === "dnd", active, conversationId: view.kind === "chat" ? view.id : undefined });
  current.current = { userId: data.user?.id ?? "", dnd: data.presence?.state === "dnd", active, conversationId: view.kind === "chat" ? view.id : undefined };
  const shown = useRef(new Map<string, number>());
  useEffect(() => {
    shown.current.clear();
    if (!chat) return;
    return subscribeMessageNotifications(chat, () => current.current, {
      play: () => audioCommands.playSoundCue("message"),
      settings: loadNotificationSettings,
      notify: notificationCommands.notifyMessage,
    }, shown.current);
  }, [chat]);
}
