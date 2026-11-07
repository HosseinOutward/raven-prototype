import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage } from "@/lib/chat/types";
if (typeof globalThis.localStorage === "undefined") {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
}
const { MessageRow } = await import("./MessageRow");
const { SeenBy } = await import("./SeenBy");
const noop = () => undefined;
const message: ChatMessage = {
  id: "m1", conversationId: "c1", seq: 1, changedSeq: 1, senderId: "sara", senderName: "Sara", clientMessageId: "client1", kind: "text", body: "Hello", createdAt: "2026-10-30T12:00:00Z",
};
const render = (onOpenPerson?: (id: string) => void) =>
  renderToStaticMarkup(<MessageRow message={message} mine={false} me="me" withAvatars showSender continuation={false} canReply canEdit={false} canDeleteForEveryone={false} onReply={noop} onEdit={noop} onRemoveForMe={noop} onDeleteForEveryone={noop} onOpenReply={noop} onOpenImage={noop} onOpenPerson={onOpenPerson} />);

describe("profile links in chat", () => {
  test("avatar and sender name are both buttons that name the sender", () => {
    const html = render(noop);
    expect(html.match(/aria-label="Open Sara’s profile"/g)).toHaveLength(2);
  });
  test("without a handler they stay plain", () => {
    expect(render()).not.toContain("’s profile");
  });
  test("seen-by rows are buttons", () => {
    const html = renderToStaticMarkup(<SeenBy direct={false} readers={[{ userId: "sara", username: "sara", displayName: "Sara", at: "2026-10-30T12:00:00Z" }]} onOpenPerson={noop} />);
    expect(html).toContain("Seen");
  });
});
