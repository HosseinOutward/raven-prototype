import type { CallHost, CaptureKind } from "@/lib/callHost";
import {
  captureAllowed,
  isNewerState,
  mobileNativeCommands,
  stateTransition,
  subscribeMobileNativeMediaState,
  type MobileNativeMediaState,
} from "./media";

/**
 * The MobileNative call host. Calls run only in the foreground while holding
 * communication audio focus, and OS permissions are asked when the user starts a capture.
 * It keeps the newest accepted native snapshot. The shell creates one per mounted app.
 */
export function createMobileNativeCallHost(): CallHost {
  let current: MobileNativeMediaState | null = null;
  const accept = (next: MobileNativeMediaState) => {
    if (!isNewerState(current, next)) return false;
    current = next;
    return true;
  };

  return {
    beginCall: async () => {
      const state = current ?? await mobileNativeCommands.getState();
      accept(state);
      accept(await mobileNativeCommands.beginCall(state.epoch));
    },
    endCall: async () => {
      accept(await mobileNativeCommands.endCall());
    },
    requestCapture: async (kind: CaptureKind) => {
      const state = await mobileNativeCommands.getState();
      accept(state);
      const answered = state[kind] === "granted" ? state : await mobileNativeCommands.requestPermission(kind, state.epoch);
      accept(answered);
      return captureAllowed(answered, kind);
    },
    capturePermitted: (kind: CaptureKind) => current?.[kind] === "granted",
    subscribe: (events) => {
      let active = true;
      let unlisten: (() => void) | null = null;
      const handle = (state: MobileNativeMediaState) => {
        if (!active) return;
        const previous = current;
        if (!accept(state)) return;
        const transition = stateTransition(previous, state);
        if (transition.refresh) events.onChanged();
        if (transition.stopCall) events.onEnded();
      };
      void subscribeMobileNativeMediaState(handle).then((stop) => {
        if (!active) {
          stop();
          return;
        }
        unlisten = stop;
        // Register first, then read the current value. Monotonic epochs resolve the race.
        void mobileNativeCommands.getState().then(handle).catch(() => undefined);
      }).catch(() => undefined);
      return () => {
        active = false;
        unlisten?.();
      };
    },
  };
}
