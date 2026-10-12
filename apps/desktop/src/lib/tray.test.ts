import { describe, expect, it } from "bun:test";
import type { ThumbnailToolbarSnapshot } from "./thumbnailToolbar";
import { buildTraySnapshot, trayCallStatus } from "./tray";

const call: ThumbnailToolbarSnapshot = {
  signedIn: true,
  micEnabled: true,
  micSupported: true,
  deafened: false,
  deafenSupported: true,
  hasMediaSession: true,
  busy: false,
  micPending: false,
  deafenPending: false,
  leavePending: false,
};

const presences = [{ id: "open", label: "Open to talk" }];

describe("tray snapshot", () => {
  it("words the connection from the media phase", () => {
    expect(trayCallStatus("connected", false)).toBe("connected");
    expect(trayCallStatus("joining", false)).toBe("connecting");
    expect(trayCallStatus("connected", true)).toBe("reconnecting");
    expect(trayCallStatus("leaving", true)).toBe("leaving");
  });

  it("carries the call fields unchanged beside the call's name", () => {
    const snapshot = buildTraySnapshot({
      call,
      callName: "  Lounge ",
      phase: "connected",
      reconnecting: false,
      presence: "open",
      presences,
    });
    expect(snapshot).toEqual({ ...call, callName: "Lounge", callStatus: "connected", presence: "open", presences });
  });

  it("names no call once the call is over", () => {
    const snapshot = buildTraySnapshot({
      call: { ...call, hasMediaSession: false },
      callName: "Lounge",
      phase: "idle",
      reconnecting: false,
      presence: "open",
      presences,
    });
    expect(snapshot.callName).toBeNull();
  });
});
