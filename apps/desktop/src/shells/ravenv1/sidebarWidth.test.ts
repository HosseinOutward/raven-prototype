import { describe, expect, test } from "bun:test";
import { clampSidebarWidth, resolveSidebarDrag, sidebarMaxWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_RAIL_WIDTH } from "./sidebarWidth";

describe("sidebar width", () => {
  test("leaves the main panel at least 600px at the minimum window", () => {
    expect(sidebarMaxWidth(980)).toBe(372);
    expect(sidebarMaxWidth(1920)).toBe(SIDEBAR_MAX_WIDTH);
    expect(sidebarMaxWidth(700)).toBe(SIDEBAR_MIN_WIDTH);
  });

  test("clamps to the allowed range", () => {
    expect(clampSidebarWidth(100, 400)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(500, 372)).toBe(372);
    expect(clampSidebarWidth(300.4, 400)).toBe(300);
  });

  test("snaps to the rail below 160px only where collapsing is allowed", () => {
    expect(resolveSidebarDrag(150, 400, true)).toEqual({ collapsed: true, width: SIDEBAR_RAIL_WIDTH });
    expect(resolveSidebarDrag(170, 400, true)).toEqual({ collapsed: false, width: SIDEBAR_MIN_WIDTH });
    expect(resolveSidebarDrag(150, 400, false)).toEqual({ collapsed: false, width: SIDEBAR_MIN_WIDTH });
  });
});
