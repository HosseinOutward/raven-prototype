import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { cn } from "@/lib/utils";
import {
  clampSidebarWidth,
  resolveSidebarDrag,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_KEY_STEP,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_RAIL_WIDTH,
} from "./sidebarWidth";

type Drag = { pointerId: number; startX: number; startWidth: number; width: number; collapsed: boolean };

// Straddles the main panel's left edge, clear of the sidebar's scrollbar. While dragging it
// writes the `--sidebar-w` variable on `target` directly, so the shell renders only when the
// sidebar crosses the rail's snap point and once more on release.
export function SidebarResizeHandle({
  target,
  width,
  maxWidth,
  collapsed,
  canCollapse,
  onCollapsedChange,
  onCommit,
}: {
  target: RefObject<HTMLElement | null>;
  width: number;
  maxWidth: number;
  collapsed: boolean;
  canCollapse: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onCommit: (next: { width: number; collapsed: boolean }) => void;
}) {
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);

  const preview = (value: number) => target.current?.style.setProperty("--sidebar-w", `${value}px`);

  // Crossing the snap point re-renders the shell, which writes the committed width back
  // into the style. Put the live width back before the frame is painted.
  useLayoutEffect(() => {
    if (drag.current) preview(drag.current.width);
  });

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = collapsed ? SIDEBAR_RAIL_WIDTH : width;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth, collapsed };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const next = resolveSidebarDrag(current.startWidth + event.clientX - current.startX, maxWidth, canCollapse);
    current.width = next.width;
    if (next.collapsed !== current.collapsed) {
      current.collapsed = next.collapsed;
      onCollapsedChange(next.collapsed);
    }
    preview(next.width);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (current.collapsed) {
      onCommit({ width, collapsed: true });
    } else {
      onCommit({ width: current.width, collapsed: false });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = collapsed ? SIDEBAR_MIN_WIDTH - SIDEBAR_KEY_STEP : width;
    const next =
      event.key === "ArrowLeft" ? (collapsed ? null : from - SIDEBAR_KEY_STEP)
      : event.key === "ArrowRight" ? (collapsed ? width : from + SIDEBAR_KEY_STEP)
      : event.key === "Home" ? SIDEBAR_MIN_WIDTH
      : event.key === "End" ? maxWidth
      : null;
    if (next == null) return;
    event.preventDefault();
    onCommit({ width: clampSidebarWidth(next, maxWidth), collapsed: false });
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={collapsed ? SIDEBAR_MIN_WIDTH : width}
      aria-valuetext={collapsed ? "Collapsed" : `${width} pixels`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onCommit({ width: clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, maxWidth), collapsed: false })}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 left-[calc(var(--sidebar-w)-3px)] z-10 flex w-1.5 cursor-col-resize touch-none justify-center rounded-chip"
    >
      <div
        aria-hidden
        className={cn(
          "my-2 w-px rounded-full transition-colors",
          dragging ? "bg-subtle" : "bg-transparent group-hover:bg-border group-focus-visible:bg-border",
        )}
      />
    </div>
  );
}
