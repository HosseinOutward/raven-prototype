// Saving and copying an image someone sent.

import { saveImage } from "./attachmentPrep";
import { saveName } from "./attachments";
import { getAttachmentUrl } from "./media";
import type { ChatAttachment } from "./types";

/** The full variant when there is one; images always have it. */
export function viewVariant(attachment: ChatAttachment): string {
  return attachment.variants.includes("full") ? "full" : attachment.variants[0] ?? "full";
}

/** The variant drawn in the message list: small, so a conversation scrolls lightly. */
export function listVariant(attachment: ChatAttachment): string {
  return attachment.variants.includes("preview") ? "preview" : viewVariant(attachment);
}

async function fullBlob(conversationId: string, attachment: ChatAttachment): Promise<Blob> {
  const url = await getAttachmentUrl(conversationId, attachment.id, viewVariant(attachment));
  return (await fetch(url)).blob();
}

/** Asks where to save the image, then saves it. False when the person cancels. */
export async function saveAttachment(conversationId: string, attachment: ChatAttachment): Promise<boolean> {
  const blob = await fullBlob(conversationId, attachment);
  const contentType = blob.type || attachment.contentType;
  return saveImage(await blob.arrayBuffer(), saveName(attachment.name, contentType), contentType);
}

/** PNG bytes of an image, converting through a canvas when it is another format. */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("no png"))), "image/png"));
}

/** Puts the image on the clipboard. WebView2 takes images only as PNG. */
export async function copyAttachment(conversationId: string, attachment: ChatAttachment): Promise<void> {
  const png = asPng(await fullBlob(conversationId, attachment));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
