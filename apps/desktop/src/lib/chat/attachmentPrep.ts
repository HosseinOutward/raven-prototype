// The native side of attachments: turning what the person picked, pasted or dropped into
// what gets uploaded, keeping it on disk until it is sent, and saving one they received.
// The commands live in src-tauri/src/attachments; docs/chat.md has their contract.

import { invoke } from "@tauri-apps/api/core";
import type { PreparedAttachment } from "./types";

export type PrepareMode = "standard" | "full";

type PrepareErrorCode = "unsupported" | "tooLarge" | "damaged" | "io";

/** A preparation that failed, with words for the person. */
export class PrepareError extends Error {
  constructor(readonly code: PrepareErrorCode | "unknown") {
    super(prepareErrorText(code));
    this.name = "PrepareError";
  }
}

export function prepareErrorText(code: string): string {
  switch (code) {
    case "unsupported":
      return "Raven can only send images for now.";
    case "tooLarge":
      return "That image is too large to send.";
    case "damaged":
      return "That image couldn’t be read.";
    default:
      return "Couldn’t get that image ready. Try adding it again.";
  }
}

function asPrepareError(error: unknown): PrepareError {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "unknown";
  return new PrepareError(code as PrepareErrorCode);
}

/**
 * JSON for a request header. Headers must be ASCII, so every other character becomes a
 * \uXXXX escape (a surrogate pair as two), which JSON reads back as the same text. File
 * names in Persian are common.
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Prepares an image from its bytes (pasted or picked). */
export async function prepareBytes(bytes: ArrayBuffer, name: string, mode: PrepareMode): Promise<PreparedAttachment> {
  try {
    return await invoke<PreparedAttachment>("attachment_prepare", new Uint8Array(bytes), { headers: { "X-Raven-Attachment": asciiJson({ name, mode }) } });
  } catch (error) {
    throw asPrepareError(error);
  }
}

/** Prepares an image from a file on this computer (dropped). */
export async function preparePath(path: string, mode: PrepareMode): Promise<PreparedAttachment> {
  try {
    return await invoke<PreparedAttachment>("attachment_prepare", { path, mode });
  } catch (error) {
    throw asPrepareError(error);
  }
}

/** The bytes of one prepared variant. */
export function readVariant(handle: string, variant: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("attachment_read", { handle, variant });
}

/** Removes a prepared attachment from disk. Harmless when it is already gone. */
export function discard(handle: string): Promise<void> {
  return invoke<void>("attachment_discard", { handle });
}

/** Removes every prepared attachment except those still waiting to be sent. */
export function sweep(keep: string[]): Promise<void> {
  return invoke<void>("attachment_sweep", { keep });
}

/** Asks where to save, then writes the bytes there. False when the person cancels. */
export async function saveImage(bytes: ArrayBuffer, name: string, contentType: string): Promise<boolean> {
  try {
    return await invoke<boolean>("attachment_save", new Uint8Array(bytes), { headers: { "X-Raven-Attachment": asciiJson({ name, contentType }) } });
  } catch (error) {
    throw asPrepareError(error);
  }
}
