import { expect, mock, test } from "bun:test";

// Making the image is slow and clearing is fast, the way the real round trips behave.
let overlay: "dot" | "none" = "none";
mock.module("@tauri-apps/api/image", () => ({
  Image: { new: () => new Promise((resolve) => setTimeout(() => resolve({}), 20)) },
}));
mock.module("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setOverlayIcon: async (icon: unknown) => {
      overlay = icon ? "dot" : "none";
    },
  }),
}));

const { setTaskbarUnread } = await import("./taskbarBadge");

test("a quick show then clear leaves the dot cleared", async () => {
  void setTaskbarUnread(true);
  await setTaskbarUnread(false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(overlay).toBe("none");

  await setTaskbarUnread(true);
  expect(overlay).toBe("dot");
});
