import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Reactions } from "./Reactions";

const props = {
  reactions: [{ emoji: "👍", count: 2, userIds: ["sara", "me"] }, { emoji: "❤️", count: 1, userIds: ["sara"] }],
  me: "me", align: "start" as const, limits: { maxPerPerson: 3, maxKinds: 20 }, canSend: true,
  nameOf: (id: string) => id === "sara" ? "Sara" : "Someone", onReact: () => {},
};

describe("reaction chips", () => {
  test("mine is pressed and highlighted, others are quiet, in server order", () => {
    const html = renderToStaticMarkup(<Reactions {...props} />);
    expect(html).toContain('aria-pressed="true" aria-label="👍 2, Sara and you"');
    expect(html).toContain('aria-pressed="false" aria-label="❤️ 1, Sara"');
    expect(html).toContain("ring-foreground/25");
    expect(html).toContain("bg-foreground/[0.07] text-muted-foreground");
    expect(html.indexOf("👍")).toBeLessThan(html.indexOf("❤️"));
  });
  test("an older server draws nothing", () => {
    expect(renderToStaticMarkup(<Reactions {...props} limits={null} />)).toBe("");
  });
  test("a few reactors show as faces, more as a count", () => {
    const many = { emoji: "🎉", count: 4, userIds: ["a", "b", "c", "d"] };
    const html = renderToStaticMarkup(<Reactions {...props} reactions={[props.reactions[0], many]} />);
    expect(html.slice(html.indexOf("🎉"))).toContain(">4<");
    expect(html.slice(0, html.indexOf("🎉"))).not.toContain(">2<");
  });
  test("no empty row", () => {
    expect(renderToStaticMarkup(<Reactions {...props} reactions={[]} />)).toBe("");
  });
  test("chips remain readable but cannot toggle when sending is forbidden", () => {
    const html = renderToStaticMarkup(<Reactions {...props} canSend={false} align="end" />);
    expect(html).toContain("justify-end");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain("hover:bg-");
  });
});


if (typeof globalThis.localStorage === "undefined") {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
}
const { MessageRow, PendingRow } = await import("./MessageRow");
const noop = () => undefined;
const message: import("@/lib/chat/types").ChatMessage = {
  id: "m1", conversationId: "c1", seq: 1, changedSeq: 1, senderId: "sara", senderName: "Sara", clientMessageId: "client1", kind: "text", body: "Hello", createdAt: "2026-10-30T12:00:00Z", reactions: props.reactions,
};
function row(patch: Partial<typeof message> = {}, options: Partial<import("./MessageRow").MessageRowProps> = {}) {
  return renderToStaticMarkup(<MessageRow message={{ ...message, ...patch }} mine={false} me="me" withAvatars={false} showSender={false} continuation={false} canReply canEdit={false} canDeleteForEveryone={false} onReply={noop} onEdit={noop} onRemoveForMe={noop} onDeleteForEveryone={noop} onOpenReply={noop} onOpenImage={noop} reactionLimits={props.limits} nameOf={props.nameOf} onReact={async () => {}} {...options} />);
}

describe("reactions on message rows", () => {
  test("the bubble puts chips between the text and time", () => {
    const html = row();
    expect(html).toContain('aria-label="React"');
    expect(html.indexOf("Hello")).toBeLessThan(html.indexOf('aria-label="👍 2'));
    expect(html.indexOf('aria-label="👍 2')).toBeLessThan(html.indexOf("<time"));
  });
  test("a bare emoji message has chips underneath, without gaining a bubble", () => {
    const html = row({ body: "😂" });
    expect(html).toContain("text-emoji-1");
    expect(html).not.toContain("rounded-card px-3 py-1.5");
    expect(html.indexOf("text-emoji-1")).toBeLessThan(html.indexOf('aria-label="👍 2'));
  });
  test("an image-only message puts chips outside and after the picture", () => {
    const html = row({ body: "", attachments: [{ id: "a1", kind: "image", source: "stored", contentType: "image/jpeg", size: 100, width: 100, height: 100, variants: ["preview", "full"] }] });
    expect(html).not.toContain("rounded-card px-3 py-1.5");
    expect(html.indexOf("aspect-ratio")).toBeLessThan(html.indexOf('aria-label="👍 2'));
  });
  test("without server support, both chips and React are absent", () => {
    const html = row({}, { reactionLimits: null });
    expect(html).not.toContain('aria-label="React"');
    expect(html).not.toContain('aria-label="👍 2');
  });
  test("deleted and system messages have neither chips nor React", () => {
    for (const patch of [{ deletedAt: message.createdAt }, { kind: "system" as const }]) {
      const html = row(patch);
      expect(html).not.toContain('aria-label="React"');
      expect(html).not.toContain('aria-label="👍 2');
    }
  });
  test("without permission the chips stay but the React control is absent", () => {
    const html = row({}, { canReply: false });
    expect(html).not.toContain('aria-label="React"');
    expect(html).toContain('aria-label="👍 2');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
  test("pending rows never show reactions", () => {
    const html = renderToStaticMarkup(<PendingRow pending={{ ...message, state: "queued", attempts: 0 }} onRetry={noop} onDiscard={noop} />);
    expect(html).not.toContain('aria-label="React"');
    expect(html).not.toContain('aria-label="👍 2');
  });
  test("hover actions remain reachable by keyboard before hovering", () => {
    const html = row();
    expect(html).toContain("group-focus-within:opacity-100");
    expect(html).not.toContain("invisible");
  });
});
