// What is waiting above the composer to go with the next message: images pasted,
// dropped or picked, each prepared on this computer before it can be sent.
//
// One tray per conversation, kept while the app is open, like the text draft. It lives
// outside React because things arrive from two places (a paste in the composer, a drop
// anywhere on the conversation) and must outlive the composer when the person looks
// elsewhere for a moment.

import type { PrepareMode } from "./attachmentPrep";
import type { PreparedAttachment } from "./types";

/** Where an item's bytes come from, kept so it can be prepared again in another mode. */
export type TraySource =
  | { kind: "bytes"; bytes: ArrayBuffer; name: string }
  | { kind: "path"; path: string };

export interface TrayItem {
  id: string;
  source: TraySource;
  status: "preparing" | "ready" | "failed";
  prepared?: PreparedAttachment;
  /** Why it could not be prepared, in words. */
  error?: string;
}

export interface Tray {
  items: TrayItem[];
  fullQuality: boolean;
}

export interface TrayBackend {
  prepare(source: TraySource, mode: PrepareMode): Promise<PreparedAttachment>;
  discard(handle: string): Promise<void>;
  /** Settles once it is safe to prepare (the startup sweep has run). */
  ready(): Promise<void>;
}

const EMPTY: Tray = { items: [], fullQuality: false };

let nextId = 0;

export class TrayStore {
  private readonly trays = new Map<string, Tray>();
  private readonly listeners = new Set<() => void>();
  /** Bumped when an item is prepared again, so an older answer is ignored. */
  private readonly generations = new Map<string, number>();

  constructor(private readonly backend: TrayBackend) {}

  get(conversationId: string): Tray {
    return this.trays.get(conversationId) ?? EMPTY;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(conversationId: string, tray: Tray) {
    if (tray.items.length === 0 && !tray.fullQuality) this.trays.delete(conversationId);
    else this.trays.set(conversationId, tray);
    for (const listener of this.listeners) listener();
  }

  private patch(conversationId: string, id: string, patch: Partial<TrayItem>) {
    const tray = this.get(conversationId);
    if (!tray.items.some((item) => item.id === id)) return;
    this.set(conversationId, { ...tray, items: tray.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
  }

  /**
   * Adds what was pasted, dropped or picked, up to `max` items in the tray. Returns how
   * many were left out for being over that.
   */
  add(conversationId: string, sources: TraySource[], max: number): number {
    const tray = this.get(conversationId);
    const room = Math.max(max - tray.items.length, 0);
    const taken = sources.slice(0, room).map((source): TrayItem => ({ id: `tray-${(nextId += 1)}`, source, status: "preparing" }));
    if (taken.length) {
      this.set(conversationId, { ...tray, items: [...tray.items, ...taken] });
      for (const item of taken) void this.prepare(conversationId, item.id);
    }
    return sources.length - taken.length;
  }

  private async prepare(conversationId: string, id: string) {
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    const item = this.get(conversationId).items.find((candidate) => candidate.id === id);
    if (!item) return;
    const mode: PrepareMode = this.get(conversationId).fullQuality ? "full" : "standard";
    try {
      await this.backend.ready();
      const prepared = await this.backend.prepare(item.source, mode);
      const still = this.get(conversationId).items.some((candidate) => candidate.id === id);
      if (!still || this.generations.get(id) !== generation) {
        // Removed, or asked for again in the other mode, while it was being prepared.
        void this.backend.discard(prepared.handle).catch(() => undefined);
        return;
      }
      this.patch(conversationId, id, { status: "ready", prepared, error: undefined });
    } catch (error) {
      if (this.generations.get(id) !== generation) return;
      this.patch(conversationId, id, { status: "failed", prepared: undefined, error: error instanceof Error ? error.message : "Couldn’t get that image ready." });
    }
  }

  remove(conversationId: string, id: string) {
    const tray = this.get(conversationId);
    const item = tray.items.find((candidate) => candidate.id === id);
    if (!item) return;
    this.generations.delete(id);
    if (item.prepared) void this.backend.discard(item.prepared.handle).catch(() => undefined);
    this.set(conversationId, { ...tray, items: tray.items.filter((candidate) => candidate.id !== id) });
  }

  /** Full quality: not resized or re-encoded. Everything in the tray is prepared again. */
  setFullQuality(conversationId: string, fullQuality: boolean) {
    const tray = this.get(conversationId);
    if (tray.fullQuality === fullQuality) return;
    for (const item of tray.items) {
      if (item.prepared) void this.backend.discard(item.prepared.handle).catch(() => undefined);
    }
    this.set(conversationId, { fullQuality, items: tray.items.map((item) => ({ ...item, status: "preparing", prepared: undefined, error: undefined })) });
    for (const item of tray.items) void this.prepare(conversationId, item.id);
  }

  /** Empties the tray and lets its files go. */
  clear(conversationId: string) {
    const tray = this.get(conversationId);
    for (const item of tray.items) {
      this.generations.delete(item.id);
      if (item.prepared) void this.backend.discard(item.prepared.handle).catch(() => undefined);
    }
    this.set(conversationId, { ...tray, items: [] });
  }

  /** Empties every tray: the account changed. */
  clearAll() {
    for (const conversationId of [...this.trays.keys()]) this.clear(conversationId);
  }

  /**
   * Hands over everything prepared, for sending, and empties the tray. The files now
   * belong to the outgoing message, so they are not discarded here.
   */
  take(conversationId: string): PreparedAttachment[] {
    const tray = this.get(conversationId);
    const prepared = tray.items.flatMap((item) => (item.prepared ? [item.prepared] : []));
    for (const item of tray.items) this.generations.delete(item.id);
    this.set(conversationId, { ...tray, items: [] });
    return prepared;
  }
}

/** Whether the tray can go with a message: nothing still preparing and nothing failed. */
export function trayReady(tray: Tray): boolean {
  return tray.items.every((item) => item.status === "ready");
}
