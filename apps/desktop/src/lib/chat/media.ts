// The app's one media cache: attachments fetched from the server, and prepared ones
// read back from this computer (the tray, and messages still being sent).

import { chatApi } from "./chatApi";
import { readVariant } from "./attachmentPrep";
import { MediaCache } from "./mediaCache";

export const mediaCache = new MediaCache();

export const serverKey = (attachmentId: string, variant: string) => `server:${attachmentId}:${variant}`;
export const localKey = (handle: string, variant: string) => `local:${handle}:${variant}`;

/** An object URL for one variant of an attachment in a conversation. */
export function getAttachmentUrl(conversationId: string, attachmentId: string, variant: string): Promise<string> {
  return mediaCache.get(serverKey(attachmentId, variant), () => chatApi.fetchVariant(conversationId, attachmentId, variant));
}

/** After one's own send: the bytes just uploaded, so the image doesn't load twice. */
export function seedAttachment(attachmentId: string, variant: string, blob: Blob): void {
  mediaCache.seed(serverKey(attachmentId, variant), blob);
}

/** An object URL for one variant of a prepared attachment that is still on this computer. */
export function getLocalUrl(handle: string, variant: string, contentType: string): Promise<string> {
  return mediaCache.get(localKey(handle, variant), async () => new Blob([await readVariant(handle, variant)], { type: contentType }));
}
