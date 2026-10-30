// The app's one tray store, wired to the native preparation commands.

import { toast } from "@/components/ui/toast";
import { discard, prepareBytes, preparePath } from "./attachmentPrep";
import type { AttachmentLimits } from "./attachments";
import { TrayStore, type TraySource } from "./tray";

let ready: Promise<void> = Promise.resolve();

/** Nothing is prepared until the chat store's startup sweep has run. */
export function setAttachmentsReady(promise: Promise<void>) {
  ready = promise;
}

export const chatTray = new TrayStore({
  prepare: (source, mode) => (source.kind === "bytes" ? prepareBytes(source.bytes, source.name, mode) : preparePath(source.path, mode)),
  discard,
  ready: () => ready,
});

/** Adds images to a conversation's tray, saying once when there were more than fit. */
export function addToTray(conversationId: string, sources: TraySource[], limits: AttachmentLimits) {
  if (sources.length === 0) return;
  const leftOut = chatTray.add(conversationId, sources, limits.maxPerMessage);
  if (leftOut > 0) {
    toast({ title: `A message can have up to ${limits.maxPerMessage} images`, description: "The rest were left out." });
  }
}
