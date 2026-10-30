import { describe, expect, test } from "bun:test";
import { modeFor, notifies, notificationText } from "./notify";
import type { ChatConversation, ChatKind, ChatMessage } from "./types";

const message = { senderName: "Sara", body: "\n**Hello**   `world`\nSecond line" } as ChatMessage;
const conversation = (kind: ChatKind) => ({ kind, name: "Crew" }) as ChatConversation;

describe("conversation notification modes", () => {
  test("defaults match the kind and every choice round-trips", () => {
    for (const kind of ["dm", "group", "nest"] as const) {
      expect(notifies(kind, undefined)).toBe(kind !== "nest");
      expect(notifies(kind, "default")).toBe(kind !== "nest");
      expect(notifies(kind, "on")).toBe(true);
      expect(notifies(kind, "off")).toBe(false);
      for (const on of [true, false]) expect(notifies(kind, modeFor(kind, on))).toBe(on);
    }
    expect(modeFor("dm", true)).toBe("default");
    expect(modeFor("group", false)).toBe("off");
    expect(modeFor("nest", false)).toBe("default");
    expect(modeFor("nest", true)).toBe("on");
  });
});

describe("Windows message text", () => {
  test("uses the first nonempty plain line and the sender or conversation title", () => {
    expect(notificationText(message, conversation("dm"), true)).toEqual({ title: "Sara", body: "Hello world" });
    for (const kind of ["group", "nest"] as const) expect(notificationText(message, conversation(kind), true)).toEqual({ title: "Crew", body: "Sara: Hello world" });
  });
  test("hides text and leaves names as plain text", () => {
    expect(notificationText({ ...message, senderName: "<Sara>" }, conversation("dm"), false)).toEqual({ title: "<Sara>", body: "Sent you a message" });
    expect(notificationText(message, conversation("group"), false).body).toBe("Sara sent a message");
  });
  test("reads fenced code, trims whitespace and cuts at 120 characters", () => {
    expect(notificationText({ ...message, body: "```ts\n\n  const x = 1;\n```" }, conversation("dm"), true).body).toBe("const x = 1;");
    expect(notificationText({ ...message, body: "a".repeat(121) }, conversation("dm"), true).body).toBe("a".repeat(120) + "…");
    expect(notificationText({ ...message, body: "a".repeat(120) }, conversation("dm"), true).body).toBe("a".repeat(120));
  });
  test("reuses attachment descriptions and prefers a caption", () => {
    const image = { kind: "image" } as NonNullable<ChatMessage["attachments"]>[number];
    expect(notificationText({ ...message, body: "", attachments: [image] }, conversation("dm"), true).body).toBe("Photo");
    expect(notificationText({ ...message, body: "  ", attachments: [image, image] }, conversation("dm"), true).body).toBe("2 photos");
    expect(notificationText({ ...message, body: "", attachments: [{ ...image, kind: "file" }] }, conversation("dm"), true).body).toBe("Attachment");
    expect(notificationText({ ...message, attachments: [image] }, conversation("dm"), true).body).toBe("Hello world");
  });
});
