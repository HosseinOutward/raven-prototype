import { memo, useMemo, type MouseEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emojiOnlyCount, parseMessage, type Inline } from "@/lib/chat/format";
import { cn } from "@/lib/utils";

/** Opens a web address in the person's browser, never inside Raven's own window. */
function openAddress(href: string) {
  void invoke("plugin:opener|open_url", { url: href }).catch(() => {
    // Not inside the desktop app (a browser preview): fall back to a new tab.
    window.open(href, "_blank", "noopener,noreferrer");
  });
}

function onLinkClick(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  openAddress(event.currentTarget.href);
}

function renderInline(nodes: Inline[], keyPrefix = ""): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;
    switch (node.type) {
      case "text":
        return node.text;
      case "bold":
        return <strong key={key} className="font-semibold">{renderInline(node.children, `${key}.`)}</strong>;
      case "italic":
        return <em key={key}>{renderInline(node.children, `${key}.`)}</em>;
      case "strike":
        return <s key={key}>{renderInline(node.children, `${key}.`)}</s>;
      case "code":
        return <code key={key} dir="ltr" className="rv-mono rounded-chip bg-card px-1 py-px text-small">{node.text}</code>;
      case "link":
        // The address is shown as written, left to right, so it reads the same in a
        // Persian sentence as in an English one.
        return (
          <a key={key} href={node.href} dir="ltr" title={node.href} onClick={onLinkClick} className="underline decoration-subtle underline-offset-2 hover:decoration-foreground">
            <bdi>{node.text}</bdi>
          </a>
        );
    }
  });
}

/**
 * The words of a message. Formatting is drawn from a parsed tree, so nothing a person
 * types is ever interpreted as markup.
 */
export const MessageText = memo(function MessageText({ body, className }: { body: string; className?: string }) {
  const blocks = useMemo(() => parseMessage(body), [body]);
  const jumbo = useMemo(() => emojiOnlyCount(body) > 0, [body]);
  return (
    <div className={cn("raven-chat-text", jumbo ? "text-display" : "text-body", className)}>
      {blocks.map((block, index) =>
        block.type === "code" ? (
          <pre key={index} dir="ltr" className="rv-mono my-1 overflow-x-auto whitespace-pre rounded-control bg-card px-2.5 py-2 text-small">
            {block.text}
          </pre>
        ) : (
          <p key={index} dir="auto">{renderInline(block.children)}</p>
        ),
      )}
    </div>
  );
});
