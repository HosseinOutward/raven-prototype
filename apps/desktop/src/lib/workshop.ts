import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, ApiError } from "@/lib/api";
import { subscribeNestUpdates } from "@/lib/eventStream";
import {
  applyShareEvent,
  type WorkshopConfig,
  type WorkshopPlaceKind,
  type WorkshopProtocol,
  type WorkshopShare,
} from "@/lib/workshopState";

// Port sharing, web side: the per-device switch, the server's config, the shares of one
// place built from events, and what the native engine reports for the shares this device
// publishes or uses. The bytes move in src-tauri/src/workshop.

const PREFERENCE_KEY = "raven.workshop.portSharing";

const preferenceListeners = new Set<() => void>();

function readPreference(): boolean {
  try {
    return localStorage.getItem(PREFERENCE_KEY) === "on";
  } catch {
    return false;
  }
}

/** The Workshop’s port sharing switch for this device. Off until chosen. */
export function setPortSharingEnabled(enabled: boolean) {
  try {
    localStorage.setItem(PREFERENCE_KEY, enabled ? "on" : "off");
  } catch {
    // Without storage the switch simply stays off.
  }
  for (const listener of preferenceListeners) listener();
  if (!enabled) stopAllSessions();
}

export function usePortSharingEnabled(): boolean {
  return useSyncExternalStore(
    (listener) => {
      preferenceListeners.add(listener);
      return () => preferenceListeners.delete(listener);
    },
    readPreference,
  );
}

/** The server’s port sharing config, once, while the device switch is on. */
export function useWorkshopConfig(enabled: boolean): WorkshopConfig | null {
  const [config, setConfig] = useState<WorkshopConfig | null>(null);
  useEffect(() => {
    if (!enabled) {
      setConfig(null);
      return;
    }
    let live = true;
    void api.workshopConfig().then((next) => live && setConfig(next)).catch(() => live && setConfig(null));
    return () => {
      live = false;
    };
  }, [enabled]);
  return config;
}

// What the native engine reports about each share this device publishes or uses.

export interface ShareSession {
  shareId: string;
  role: "publisher" | "consumer";
  state: "live" | "ended";
  /** Set when state is "ended". */
  reason?: string;
  /** Latest problem that did not end the share, such as nothing listening on the port. */
  notice?: string;
  route?: string;
  /** The endpoint that won the race, as the server listed it. */
  endpoint?: string;
  /** The port a consumer listens on, 127.0.0.1:<localPort>. */
  localPort?: number;
  bytesUp: number;
  bytesDown: number;
  flows: number;
  udpDropped: number;
}

interface NativeStatus {
  shareId: string;
  role: "publisher" | "consumer";
  state: "live" | "notice" | "ended";
  reason?: string | null;
  notice?: string | null;
  bytesUp: number;
  bytesDown: number;
  flows: number;
  udpDropped: number;
}

let sessions: ReadonlyMap<string, ShareSession> = new Map();
const sessionListeners = new Set<() => void>();
let nativeListening = false;

const sessionKey = (role: string, shareId: string) => `${role}:${shareId}`;

function setSession(next: ShareSession | null, key: string) {
  const map = new Map(sessions);
  if (next) map.set(key, next);
  else map.delete(key);
  sessions = map;
  for (const listener of sessionListeners) listener();
}

function listenNative() {
  if (nativeListening) return;
  nativeListening = true;
  void listen<NativeStatus>("workshop://status", ({ payload }) => {
    const key = sessionKey(payload.role, payload.shareId);
    const previous = sessions.get(key);
    if (!previous && payload.state !== "ended") return;
    const base: ShareSession = previous ?? { shareId: payload.shareId, role: payload.role, state: "live", bytesUp: 0, bytesDown: 0, flows: 0, udpDropped: 0 };
    if (payload.state === "notice") {
      setSession({ ...base, notice: payload.notice ?? undefined }, key);
      return;
    }
    setSession(
      {
        ...base,
        state: payload.state,
        reason: payload.reason ?? undefined,
        bytesUp: payload.bytesUp,
        bytesDown: payload.bytesDown,
        flows: payload.flows,
        udpDropped: payload.udpDropped,
      },
      key,
    );
  });
}

export function useShareSessions(): ReadonlyMap<string, ShareSession> {
  useEffect(listenNative, []);
  return useSyncExternalStore(
    (listener) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    () => sessions,
  );
}

export function sessionFor(map: ReadonlyMap<string, ShareSession>, role: "publisher" | "consumer", shareId: string) {
  return map.get(sessionKey(role, shareId));
}

/** The server ended a share: close what this device holds for it and remember why. */
function endSessionsOf(shareId: string, reason: string | undefined) {
  for (const role of ["publisher", "consumer"] as const) {
    const held = sessions.get(sessionKey(role, shareId));
    if (!held || held.state === "ended") continue;
    void invoke(role === "publisher" ? "workshop_stop" : "workshop_disconnect", { shareId }).catch(() => undefined);
    setSession({ ...held, state: "ended", reason }, sessionKey(role, shareId));
  }
}

/** The shares of one voice nest or text room, kept current from events. */
export function usePlaceShares(placeKind: WorkshopPlaceKind, placeId: string, enabled: boolean): WorkshopShare[] {
  const [shares, setShares] = useState<WorkshopShare[]>([]);
  useEffect(() => {
    setShares([]);
    if (!enabled) return;
    let live = true;
    const load = () => void api.workshopShares(placeKind, placeId).then((reply) => live && setShares(reply.shares)).catch(() => undefined);
    load();
    const stop = subscribeNestUpdates((update) => {
      if (update.type === "stream.reconnected") return load();
      if (!update.type.startsWith("workshop.share.") || !update.share) return;
      if (update.share.placeKind !== placeKind || update.share.placeId !== placeId) return;
      if (update.type === "workshop.share.ended") endSessionsOf(update.share.id, update.reason);
      setShares((current) => applyShareEvent(current, update.type, update.share!));
    });
    return () => {
      live = false;
      stop();
    };
  }, [placeKind, placeId, enabled]);
  return shares;
}

export interface PublishRequest {
  placeKind: WorkshopPlaceKind;
  placeId: string;
  name: string;
  protocol: WorkshopProtocol;
  port: number;
  audience: "all" | string[];
  minutes: number;
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong.";
}

/**
 * Registers the share with the server, then connects this device to the relay so it can
 * serve it. If the relay cannot be reached the share is withdrawn again, so nothing is
 * left listed that nobody can use.
 */
export async function publishShare(config: WorkshopConfig, request: PublishRequest): Promise<WorkshopShare> {
  const { share } = await api.createWorkshopShare(request);
  try {
    const started = await invoke<{ route: string; endpoint: string }>("workshop_publish", {
      args: { endpoints: config.endpoints, token: api.getSessionId(), shareId: share.id, port: share.port },
    });
    setSession(
      { shareId: share.id, role: "publisher", state: "live", route: started.route, endpoint: started.endpoint, bytesUp: 0, bytesDown: 0, flows: 0, udpDropped: 0 },
      sessionKey("publisher", share.id),
    );
  } catch (error) {
    await api.deleteWorkshopShare(share.id).catch(() => undefined);
    throw new Error(messageOf(error));
  }
  return share;
}

export async function stopShare(shareId: string) {
  await invoke("workshop_stop", { shareId }).catch(() => undefined);
  setSession(null, sessionKey("publisher", shareId));
  await api.deleteWorkshopShare(shareId).catch(() => undefined);
}

export async function extendShare(shareId: string, minutes: number) {
  await api.extendWorkshopShare(shareId, minutes);
}

export async function connectShare(config: WorkshopConfig, share: WorkshopShare) {
  try {
    const started = await invoke<{ route: string; endpoint: string; localPort: number; notice: string | null }>("workshop_connect", {
      args: { endpoints: config.endpoints, token: api.getSessionId(), shareId: share.id, protocol: share.protocol, port: share.port },
    });
    setSession(
      {
        shareId: share.id, role: "consumer", state: "live", route: started.route, endpoint: started.endpoint, localPort: started.localPort,
        notice: started.notice ?? undefined, bytesUp: 0, bytesDown: 0, flows: 0, udpDropped: 0,
      },
      sessionKey("consumer", share.id),
    );
  } catch (error) {
    throw new Error(messageOf(error));
  }
}

export async function disconnectShare(shareId: string) {
  await invoke("workshop_disconnect", { shareId }).catch(() => undefined);
  setSession(null, sessionKey("consumer", shareId));
}

/**
 * Stops everything this device publishes or uses, for whichever account started it. Runs
 * when the switch goes off and whenever the signed-in account changes, including at
 * startup, where anything still running belongs to a page that is gone.
 */
export function stopAllSessions() {
  void invoke("workshop_stop_all").catch(() => undefined);
  if (sessions.size === 0) return;
  sessions = new Map();
  for (const listener of sessionListeners) listener();
}

/** Forgets a finished session once the person has seen how it ended. */
export function dismissSession(role: "publisher" | "consumer", shareId: string) {
  setSession(null, sessionKey(role, shareId));
}
