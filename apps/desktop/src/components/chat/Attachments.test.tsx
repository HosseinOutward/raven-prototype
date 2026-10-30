import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatAttachment } from "@/lib/chat/types";

// The API client reads the saved session when it is created; there is none here.
// Another test file may already have put one in place.
if (typeof globalThis.localStorage === "undefined") {
  const memory = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value), removeItem: (key: string) => void memory.delete(key) },
  });
}
const { MessageAttachments } = await import("./Attachments");

const attachment = (patch: Partial<ChatAttachment>): ChatAttachment => ({
  id: "a1",
  kind: "image",
  source: "stored",
  contentType: "image/jpeg",
  size: 1000,
  width: 800,
  height: 600,
  variants: ["full", "preview"],
  ...patch,
});

const UPDATE_LINE = "Sent from a newer version of Raven. Update to see it.";

describe("the renderer map", () => {
  test("a kind this version doesn't know renders the update line", () => {
    const html = renderToStaticMarkup(<MessageAttachments conversationId="c1" senderName="Ava" attachments={[attachment({ kind: "sticker", source: "pack" })]} />);
    expect(html).toContain(UPDATE_LINE);
    expect(html).not.toContain("<img");
  });

  test("so does a source it can't fetch from", () => {
    const html = renderToStaticMarkup(<MessageAttachments conversationId="c1" senderName="Ava" attachments={[attachment({ source: "peer", variants: [] })]} />);
    expect(html).toContain(UPDATE_LINE);
  });

  test("an image reserves its box before it loads", () => {
    const html = renderToStaticMarkup(<MessageAttachments conversationId="c1" senderName="Ava" attachments={[attachment({})]} />);
    expect(html).not.toContain(UPDATE_LINE);
    expect(html).toContain("width:400px");
    expect(html).toContain("aspect-ratio:400 / 300");
  });
});
