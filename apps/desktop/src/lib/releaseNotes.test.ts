import { describe, expect, test } from "bun:test";
import { parseInline, parseNotes } from "./releaseNotes";

describe("release notes markdown", () => {
  test("headings, wrapped bullets and paragraphs", () => {
    const blocks = parseNotes("# Raven 0.1.7\r\n\n## New\n\n- One\n- Two\n  continues\n\nClosing line.");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Raven 0.1.7" },
      { kind: "heading", level: 2, text: "New" },
      { kind: "list", items: ["One", "Two continues"] },
      { kind: "paragraph", text: "Closing line." },
    ]);
  });

  test("inline code, bold and http links; other links stay text", () => {
    expect(parseInline("Use `:smile:` in **chat** [docs](https://example.com/a) [x](javascript:alert(1))")).toEqual([
      { kind: "text", text: "Use " },
      { kind: "code", text: ":smile:" },
      { kind: "text", text: " in " },
      { kind: "bold", text: "chat" },
      { kind: "text", text: " " },
      { kind: "link", text: "docs", href: "https://example.com/a" },
      { kind: "text", text: " [x](javascript:alert(1))" },
    ]);
  });
});
