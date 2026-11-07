import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { forwardSections, sourceWouldShow } from "@/lib/chat/forward";
import { canSelect, clickSelection, selectionAfterKey, startSelection } from "@/lib/chat/selection";
import type { ChatMessage, ConversationState } from "@/lib/chat/types";
if (typeof globalThis.localStorage === "undefined") {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
}
const { ForwardedFrom, MessageRow } = await import("./MessageRow");
const noop = () => undefined;

const message: ChatMessage = {
  id: "m1", conversationId: "c1", seq: 1, changedSeq: 1, senderId: "sara", senderName: "Sara", clientMessageId: "x", kind: "text", body: "Hello", createdAt: "2026-11-01T12:00:00Z",
};
const rowProps = {
  message, mine: false, me: "me", withAvatars: false, showSender: false, continuation: false, canReply: true, canEdit: false, canDeleteForEveryone: false,
  onReply: noop, onEdit: noop, onRemoveForMe: noop, onDeleteForEveryone: noop, onOpenReply: noop, onOpenImage: noop,
};

describe("choosing messages", () => {
  const order = ["a", "b", "c", "d", "e"];

  test("a click flips one message", () => {
    let selection = startSelection("b");
    selection = clickSelection(selection, "d", false, order);
    expect([...selection.ids].sort()).toEqual(["b", "d"]);
    selection = clickSelection(selection, "b", false, order);
    expect([...selection.ids]).toEqual(["d"]);
  });

  test("a shift-click takes the range from the last click, either way", () => {
    expect([...clickSelection(startSelection("b"), "d", true, order).ids].sort()).toEqual(["b", "c", "d"]);
    expect([...clickSelection(startSelection("d"), "a", true, order).ids].sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("Esc leaves and other keys do not", () => {
    const selection = startSelection("a");
    expect(selectionAfterKey(selection, "Escape")).toBeNull();
    expect(selectionAfterKey(selection, "a")).toBe(selection);
  });

  test("system lines and deleted messages cannot be chosen", () => {
    expect(canSelect(message)).toBe(true);
    expect(canSelect({ kind: "system" })).toBe(false);
    expect(canSelect({ kind: "text", deletedAt: "2026-11-01T12:00:00Z" })).toBe(false);
  });

  test("a row being chosen shows its check and no actions", () => {
    const off = renderToStaticMarkup(<MessageRow {...rowProps} />);
    expect(off).toContain("More for this message");
    expect(off).not.toContain('role="checkbox"');
    const on = renderToStaticMarkup(<MessageRow {...rowProps} selecting selected />);
    expect(on).toContain('role="checkbox"');
    expect(on).toContain('aria-checked="true"');
    expect(on).not.toContain("More for this message");
  });

  test("a deleted row has no check while choosing", () => {
    const html = renderToStaticMarkup(<MessageRow {...rowProps} message={{ ...message, deletedAt: "2026-11-01T12:00:00Z" }} selecting />);
    expect(html).not.toContain('role="checkbox"');
  });
});

describe("the origin line variants", () => {
  const createdAt = "2026-10-30T12:00:00Z";
  const source = { conversationId: "g", kind: "group" as const, name: "Study group", seq: 4 };

  test("hidden sender reads Forwarded, with no name", () => {
    const html = renderToStaticMarkup(<ForwardedFrom origin={{ createdAt, source }} />);
    expect(html).toContain("Forwarded");
    expect(html).toContain("Study group");
    expect(html).not.toContain("Forwarded from");
  });

  test("hidden source leaves the sender's name only", () => {
    const html = renderToStaticMarkup(<ForwardedFrom origin={{ createdAt, senderId: "s", senderName: "Sara" }} />);
    expect(html).toContain("Sara");
    expect(html).not.toContain("Study group");
  });

  test("both hidden reads Forwarded alone", () => {
    const html = renderToStaticMarkup(<ForwardedFrom origin={{ createdAt }} />);
    expect(html).toContain("Forwarded");
    expect(html).not.toContain("Sara");
    expect(html).not.toContain("<button");
  });
});

function conversation(summary: Partial<ConversationState["summary"]>): ConversationState {
  return { summary: { id: "x", kind: "group", name: "", canSend: true, archived: false, ...summary } } as ConversationState;
}

describe("where a forward can go", () => {
  const all = [
    conversation({ id: "s", kind: "saved" }),
    conversation({ id: "g", kind: "group", name: "Band" }),
    conversation({ id: "gone", kind: "group", name: "Old", archived: true }),
    conversation({ id: "d", kind: "dm", name: "", peer: { id: "p", username: "pat", displayName: "Pat" } as ConversationState["summary"]["peer"] }),
    conversation({ id: "shut", kind: "dm", name: "", canSend: false, peer: { id: "q", username: "quin", displayName: "Quin" } as ConversationState["summary"]["peer"] }),
    conversation({ id: "n", kind: "nest", name: "general", treeId: "t1" }),
    conversation({ id: "m", kind: "nest", name: "other", treeId: "t2" }),
  ];
  const trees = [{ id: "t1", name: "Home" }, { id: "t2", name: "Work" }, { id: "t3", name: "Empty" }];

  test("Saved, then people, then one section per tree, only where you can send", () => {
    const sections = forwardSections(all, trees, "");
    expect(sections.map((section) => section.title)).toEqual(["", "Friends and groups", "Home", "Work"]);
    expect(sections[1].destinations.map((each) => each.name)).toEqual(["Band", "Pat"]);
    expect(sections[0].destinations[0].id).toBe("s");
  });

  test("a Saved messages not yet created is still offered", () => {
    const sections = forwardSections(all.filter(({ summary }) => summary.kind !== "saved"), trees, "");
    expect(sections[0].destinations[0]).toMatchObject({ id: "", kind: "saved" });
  });

  test("search narrows to matches, and a tree's name finds its nests", () => {
    expect(forwardSections(all, trees, "pat").flatMap((section) => section.destinations.map((each) => each.id))).toEqual(["d"]);
    expect(forwardSections(all, trees, "work").flatMap((section) => section.destinations.map((each) => each.id))).toEqual(["m"]);
  });
});

describe("whether hiding the source changes anything", () => {
  test("a message written here shows its chat, unless that is Saved messages", () => {
    expect(sourceWouldShow([message], "group")).toBe(true);
    expect(sourceWouldShow([message], "saved")).toBe(false);
  });

  test("a copy shows a source only if it still has one", () => {
    const hidden = { ...message, origin: { createdAt: message.createdAt } };
    const shown = { ...message, origin: { createdAt: message.createdAt, source: { conversationId: "g", kind: "group" as const, name: "G", seq: 1 } } };
    expect(sourceWouldShow([hidden], "group")).toBe(false);
    expect(sourceWouldShow([hidden, shown], "group")).toBe(true);
  });

  test("a message no longer loaded counts as showing it", () => {
    expect(sourceWouldShow([undefined], "saved")).toBe(true);
  });
});
