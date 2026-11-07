import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage, ChatOrigin } from "@/lib/chat/types";
if (typeof globalThis.localStorage === "undefined") {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
}
const { ForwardedFrom, MessageRow } = await import("./MessageRow");
const noop = () => undefined;

const origin: ChatOrigin = {
  senderId: "sara",
  senderName: "Sara",
  createdAt: "2026-10-30T12:00:00Z",
  source: { conversationId: "group1", kind: "group", name: "Study group", seq: 42 },
};
const message: ChatMessage = {
  id: "m1", conversationId: "saved1", seq: 1, changedSeq: 1, senderId: "me", senderName: "Me", clientMessageId: "copy-1", kind: "text", body: "Keep this", origin, createdAt: "2026-11-01T12:00:00Z",
};

/** The buttons in a rendered tree, with their handlers. */
function buttons(node: ReactNode): ReactElement<{ "aria-label"?: string; onClick: () => void }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const own = node.type === "button" ? [node as ReactElement<{ "aria-label"?: string; onClick: () => void }>] : [];
  return [...own, ...buttons(node.props.children)];
}

describe("the origin line", () => {
  test("shows the sender and the chat it came from", () => {
    const html = renderToStaticMarkup(<ForwardedFrom origin={origin} onOpenPerson={noop} onOpenSource={noop} />);
    expect(html).toContain("Sara");
    expect(html).toContain("Study group");
    expect(html).toContain("Forwarded from");
  });

  test("the chat opens at the original and the sender opens their profile", () => {
    const opened: unknown[] = [];
    const tree = ForwardedFrom({ origin, onOpenPerson: (id) => opened.push(["person", id]), onOpenSource: (id, seq) => opened.push(["chat", id, seq]) });
    for (const button of buttons(tree)) button.props.onClick();
    expect(opened).toEqual([["person", "sara"], ["chat", "group1", 42]]);
  });

  test("drops the chat when the viewer can no longer read it", () => {
    const html = renderToStaticMarkup(<ForwardedFrom origin={{ ...origin, source: undefined }} onOpenPerson={noop} onOpenSource={noop} />);
    expect(html).toContain("Sara");
    expect(html).not.toContain("Study group");
  });

  test("a hidden sender and chat read as Forwarded", () => {
    const tree = ForwardedFrom({ origin: { createdAt: origin.createdAt } });
    expect(buttons(tree)).toHaveLength(0);
    expect(renderToStaticMarkup(tree)).toContain(">Forwarded<");
  });

  const row = (patch: Partial<ChatMessage>, inSaved = true) => renderToStaticMarkup(
    <MessageRow message={{ ...message, ...patch }} mine me="me" withAvatars={false} showSender={false} continuation={false} canReply canEdit={false} canDeleteForEveryone inSaved={inSaved} onReply={noop} onEdit={noop} onRemoveForMe={noop} onDeleteForEveryone={noop} onOpenReply={noop} onOpenImage={noop} onOpenPerson={noop} onOpenSource={noop} />,
  );

  test("a saved copy shows it above the text, with no delivery status", () => {
    const html = row({});
    expect(html).toContain("Study group");
    expect(html).toContain("Keep this");
    expect(html).not.toContain('aria-label="Sent"');
  });

  test("a note of your own has no origin line, and a deleted copy shows none", () => {
    expect(row({ origin: undefined })).not.toContain("Forwarded");
    expect(row({ deletedAt: "2026-11-02T12:00:00Z" })).not.toContain("Study group");
  });
});
