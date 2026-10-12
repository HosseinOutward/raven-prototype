// The chat store: one place that holds what the app knows about conversations, talks to
// the server, and keeps the two in step.
//
// The rules for staying in step are the pure functions in `reducer.ts`. This file does
// the work those rules ask for (fetch the changes after a gap, fetch a list entry again)
// and the person's own actions (send, edit, read). It has no React in it; components
// read it through `useSyncExternalStore`, so a new message re-renders the conversation it
// belongs to and nothing else.

import type { ChatApi } from "./chatApi";
import { httpStatusOf } from "./errors";
import { classifySendFailure, clearOutbox, loadOutbox, newClientMessageId, nextToSend, saveOutbox, SEND_RETRY_WINDOW_MS, type OutboxStorage } from "./outbox";
import {
  addPending,
  applyChanges,
  applyEvent,
  applyList,
  applyOwnMessage,
  applyPage,
  applySummary,
  emptyChatState,
  expireTyping,
  markReadLocally,
  nextTypingExpiry,
  removeConversation,
  removeMessageLocally,
  removePending,
  setLayout,
  setLoading,
  setSettings,
  unloadConversation,
  updatePending,
  type PageMode,
} from "./reducer";
import type { ChatConversation, ChatEffect, ChatEvent, ChatMember, ChatReplyRef, ChatState, ChatUser, PendingMessage, Reduced, TreeLayout } from "./types";

/** How many conversations keep their messages loaded besides the ones on screen. */
const KEPT_LOADED = 3;
const PAGE_SIZE = 50;
/** Open at the first unread message rather than the newest once this many are unread. */
const OPEN_AT_UNREAD_FROM = 30;
const READ_DEBOUNCE_MS = 250;
const TYPING_INTERVAL_MS = 4000;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];

type Timer = ReturnType<typeof setTimeout>;

export interface ChatStoreOptions {
  api: ChatApi;
  me: ChatUser;
  /** Where unsent messages are kept across a restart. Leave out in windows that should not keep them. */
  storage?: OutboxStorage | null;
  /** Called when the server says the session has ended. */
  onSignedOut?: () => void;
  now?: () => number;
  /** Multiplies every wait (retries, debounces). Tests shrink it; the app leaves it at 1. */
  delayScale?: number;
}

function isNotFound(error: unknown): boolean {
  return httpStatusOf(error) === 404;
}

export class ChatStore {
  private state: ChatState;
  private readonly listeners = new Set<() => void>();
  private readonly api: ChatApi;
  private readonly me: ChatUser;
  private readonly storage: OutboxStorage | null;
  private readonly onSignedOut?: () => void;
  private readonly now: () => number;
  private readonly delayScale: number;
  private disposed = false;

  // The list fetch: one at a time, remembering which conversations moved during it.
  private listFetching = false;
  private listAgain = false;
  private listAttempts = 0;
  private listTimer: Timer | null = null;
  private listDirty = new Set<string>();

  private readonly changesFetching = new Set<string>();
  private readonly changesAgain = new Set<string>();
  private readonly changesTimers = new Map<string, Timer>();
  private readonly summaryFetching = new Set<string>();
  private readonly summaryAgain = new Set<string>();

  private readonly sending = new Set<string>();
  private readonly sendTimers = new Map<string, Timer>();
  private readonly firstAttemptAt = new Map<string, number>();

  private readonly readTimers = new Map<string, Timer>();
  private readonly readTargets = new Map<string, number>();
  private readonly lastTypingAt = new Map<string, number>();
  private typingTimer: Timer | null = null;

  /** Conversations on screen, and recently on screen (most recent last). */
  private readonly open = new Set<string>();
  private recent: string[] = [];
  private readonly atBottom = new Map<string, boolean>();

  constructor(options: ChatStoreOptions) {
    this.api = options.api;
    this.me = options.me;
    this.storage = options.storage ?? null;
    this.onSignedOut = options.onSignedOut;
    this.now = options.now ?? Date.now;
    this.delayScale = options.delayScale ?? 1;
    this.state = emptyChatState(options.me.id);
  }

  private later(run: () => void, delayMs: number): Timer {
    return setTimeout(run, delayMs * this.delayScale);
  }

  // ---- reading ----------------------------------------------------------------------

  getState = (): ChatState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(next: ChatState) {
    if (next === this.state || this.disposed) return;
    const pendingChanged = this.storage && this.pendingOf(next) !== this.pendingOf(this.state);
    this.state = next;
    if (pendingChanged) this.persistOutbox();
    this.scheduleTypingExpiry();
    for (const listener of this.listeners) listener();
  }

  private pendingOf(state: ChatState): string {
    // Cheap fingerprint of every unsent message, to tell when they need saving again.
    let key = "";
    for (const conversation of Object.values(state.conversations)) {
      for (const item of conversation.pending) key += `${item.clientMessageId}:${item.state};`;
    }
    return key;
  }

  private persistOutbox() {
    if (!this.storage) return;
    const all = Object.values(this.state.conversations).flatMap((conversation) => conversation.pending);
    saveOutbox(this.storage, this.me.id, all);
  }

  private apply(reduced: Reduced) {
    this.set(reduced.state);
    this.run(reduced.effects);
  }

  // ---- the stream -------------------------------------------------------------------

  /** The event stream is open. Whatever happened while it was not is fetched now. */
  streamOpened() {
    if (this.disposed) return;
    this.set({ ...this.state, connection: "live" });
    this.refreshList();
  }

  streamClosed() {
    if (this.disposed) return;
    this.set({ ...this.state, connection: "offline" });
  }

  handleEvent(event: ChatEvent) {
    if (this.disposed || !event || typeof event.type !== "string") return;
    if (this.listFetching && event.conversationId) this.listDirty.add(event.conversationId);
    this.apply(applyEvent(this.state, event, this.now(), this.atBottom.get(event.conversationId) ?? true));
    if (event.type === "conversation.removed") this.forget(event.conversationId);
  }

  /** Friends or tree membership changed, which decides what can be seen and sent. */
  accessMayHaveChanged() {
    this.refreshList();
  }

  /** Fetches one conversation's details again, including who is in it. */
  refreshConversation(conversationId: string) {
    void this.fetchSummary(conversationId);
  }

  private run(effects: ChatEffect[]) {
    for (const effect of effects) {
      switch (effect.type) {
        case "fetchList":
          this.refreshList();
          break;
        case "fetchSummary":
          void this.fetchSummary(effect.conversationId);
          break;
        case "fetchChanges":
          void this.fetchChanges(effect.conversationId);
          break;
        case "reload":
          void this.reload(effect.conversationId);
          break;
      }
    }
  }

  refreshList() {
    if (this.disposed) return;
    if (this.listFetching) {
      this.listAgain = true;
      return;
    }
    if (this.listTimer) {
      clearTimeout(this.listTimer);
      this.listTimer = null;
    }
    this.listFetching = true;
    this.listDirty = new Set();
    void this.api.listConversations().then(
      ({ conversations, settings }) => {
        this.listFetching = false;
        this.listAttempts = 0;
        const firstLoad = !this.state.listLoaded;
        const reduced = applyList(this.state, conversations, settings, this.listDirty);
        this.apply(firstLoad ? this.restoreOutbox(reduced) : reduced);
        if (this.listAgain) {
          this.listAgain = false;
          this.refreshList();
        }
      },
      (error) => {
        this.listFetching = false;
        if (this.handleSignedOut(error) || this.disposed) return;
        // Without the list the app does not know what it missed, so keep trying.
        this.listAttempts += 1;
        const delay = RETRY_DELAYS_MS[Math.min(this.listAttempts, RETRY_DELAYS_MS.length) - 1];
        this.listTimer = this.later(() => {
          this.listTimer = null;
          this.refreshList();
        }, delay);
      },
    );
  }

  /** Puts back the messages that were unsent when the app last closed. */
  private restoreOutbox(reduced: Reduced): Reduced {
    if (!this.storage) return reduced;
    let state = reduced.state;
    for (const item of loadOutbox(this.storage, this.me.id)) state = addPending(state, item);
    return { state, effects: reduced.effects };
  }

  private async fetchSummary(conversationId: string) {
    if (this.summaryFetching.has(conversationId)) {
      this.summaryAgain.add(conversationId);
      return;
    }
    this.summaryFetching.add(conversationId);
    try {
      const { conversation, members } = await this.api.getConversation(conversationId);
      this.apply(applySummary(this.state, conversation, members));
    } catch (error) {
      if (isNotFound(error)) {
        this.set(removeConversation(this.state, conversationId));
        this.forget(conversationId);
      } else {
        this.handleSignedOut(error);
      }
    } finally {
      this.summaryFetching.delete(conversationId);
      if (this.summaryAgain.delete(conversationId)) void this.fetchSummary(conversationId);
    }
  }

  private async fetchChanges(conversationId: string, attempt = 0) {
    if (this.changesFetching.has(conversationId)) {
      this.changesAgain.add(conversationId);
      return;
    }
    const conversation = this.state.conversations[conversationId];
    if (!conversation?.loaded) return;
    const timer = this.changesTimers.get(conversationId);
    if (timer) {
      clearTimeout(timer);
      this.changesTimers.delete(conversationId);
    }
    this.changesFetching.add(conversationId);
    try {
      const changes = await this.api.changes(conversationId, conversation.syncedSeq);
      this.changesFetching.delete(conversationId);
      this.changesAgain.delete(conversationId);
      // What it returns already says whether more is needed.
      this.apply(applyChanges(this.state, conversationId, changes));
    } catch (error) {
      this.changesFetching.delete(conversationId);
      this.changesAgain.delete(conversationId);
      if (isNotFound(error)) {
        this.set(removeConversation(this.state, conversationId));
        this.forget(conversationId);
        return;
      }
      if (this.handleSignedOut(error) || this.disposed) return;
      // The window knows it is incomplete. Keep trying until it is not.
      const delay = RETRY_DELAYS_MS[Math.min(attempt + 1, RETRY_DELAYS_MS.length) - 1];
      this.changesTimers.set(conversationId, this.later(() => {
        this.changesTimers.delete(conversationId);
        void this.fetchChanges(conversationId, attempt + 1);
      }, delay));
    }
  }

  private async reload(conversationId: string) {
    this.set(unloadConversation(this.state, conversationId));
    if (this.open.has(conversationId)) await this.loadInitial(conversationId);
  }

  private handleSignedOut(error: unknown): boolean {
    if (httpStatusOf(error) !== 401) return false;
    this.onSignedOut?.();
    return true;
  }

  private forget(conversationId: string) {
    this.open.delete(conversationId);
    this.recent = this.recent.filter((id) => id !== conversationId);
    this.atBottom.delete(conversationId);
  }

  // ---- opening and paging -------------------------------------------------------------

  /** A conversation is on screen: load its messages if they are not loaded. */
  async openConversation(conversationId: string) {
    this.open.add(conversationId);
    this.recent = [...this.recent.filter((id) => id !== conversationId), conversationId];
    if (!this.state.conversations[conversationId]) await this.fetchSummary(conversationId);
    const conversation = this.state.conversations[conversationId];
    if (conversation && !conversation.loaded && conversation.loading === "idle") await this.loadInitial(conversationId);
  }

  /** A conversation left the screen. Its messages stay loaded for a while in case it is reopened. */
  closeConversation(conversationId: string) {
    this.open.delete(conversationId);
    // Not when it was left somewhere back in the history. Reopening shows the newest
    // messages, and getting there from an old window page by page could take hundreds
    // of requests; starting over takes one.
    if (this.state.conversations[conversationId]?.hasMoreAfter) {
      this.recent = this.recent.filter((id) => id !== conversationId);
      this.set(unloadConversation(this.state, conversationId));
    }
    const idle = this.recent.filter((id) => !this.open.has(id));
    for (const id of idle.slice(0, Math.max(idle.length - KEPT_LOADED, 0))) {
      this.recent = this.recent.filter((candidate) => candidate !== id);
      this.set(unloadConversation(this.state, id));
    }
  }

  /** Whether the person is looking at the newest messages of a conversation. */
  setAtBottom(conversationId: string, atBottom: boolean) {
    this.atBottom.set(conversationId, atBottom);
  }

  private async loadPage(conversationId: string, loading: "initial" | "older" | "newer", cursor: { before?: number; after?: number; around?: number; limit?: number }, mode: PageMode) {
    const conversation = this.state.conversations[conversationId];
    if (!conversation || conversation.loading !== "idle") return;
    this.set(setLoading(this.state, conversationId, loading));
    try {
      const page = await this.api.messages(conversationId, { limit: PAGE_SIZE, ...cursor });
      this.apply(applyPage(this.state, conversationId, page, mode));
    } catch (error) {
      this.set(setLoading(this.state, conversationId, "idle"));
      if (isNotFound(error)) {
        this.set(removeConversation(this.state, conversationId));
        this.forget(conversationId);
        return;
      }
      if (!this.handleSignedOut(error)) throw error;
    }
  }

  private loadInitial(conversationId: string) {
    const summary = this.state.conversations[conversationId]?.summary;
    // With a lot unread, start where the person left off; otherwise at the newest.
    const cursor = summary && summary.unreadCount >= OPEN_AT_UNREAD_FROM && summary.readSeq > 0 ? { around: summary.readSeq, limit: PAGE_SIZE * 2 } : {};
    return this.loadPage(conversationId, "initial", cursor, "replace").catch(() => undefined);
  }

  loadOlder(conversationId: string) {
    const conversation = this.state.conversations[conversationId];
    if (!conversation?.loaded || !conversation.hasMoreBefore || conversation.messages.length === 0) return Promise.resolve();
    return this.loadPage(conversationId, "older", { before: conversation.messages[0].seq }, "older").catch(() => undefined);
  }

  loadNewer(conversationId: string) {
    const conversation = this.state.conversations[conversationId];
    if (!conversation?.loaded || !conversation.hasMoreAfter || conversation.messages.length === 0) return Promise.resolve();
    return this.loadPage(conversationId, "newer", { after: conversation.messages[conversation.messages.length - 1].seq }, "newer").catch(() => undefined);
  }

  jumpToLatest(conversationId: string) {
    return this.loadPage(conversationId, "initial", {}, "replace").catch(() => undefined);
  }

  /** Brings a message into the window, for following a reply to what it quotes. */
  async jumpTo(conversationId: string, seq: number) {
    const conversation = this.state.conversations[conversationId];
    if (conversation?.messages.some((message) => message.seq === seq)) return;
    await this.loadPage(conversationId, "initial", { around: seq, limit: PAGE_SIZE }, "replace").catch(() => undefined);
  }

  // ---- sending ------------------------------------------------------------------------

  /** Shows the message at once and sends it in the background. Returns its client id. */
  send(conversationId: string, body: string, replyTo?: ChatReplyRef): string | null {
    const text = body.trim();
    if (!text || !this.state.conversations[conversationId]) return null;
    const pending: PendingMessage = {
      clientMessageId: newClientMessageId(),
      conversationId,
      body: text,
      replyTo,
      createdAt: new Date(this.now()).toISOString(),
      state: "queued",
      attempts: 0,
    };
    this.set(addPending(this.state, pending));
    this.pump(conversationId);
    return pending.clientMessageId;
  }

  /** Sends a failed message again. It keeps its id, so it cannot arrive twice. */
  retry(conversationId: string, clientMessageId: string) {
    this.firstAttemptAt.delete(clientMessageId);
    this.set(updatePending(this.state, conversationId, clientMessageId, { state: "queued", error: undefined, attempts: 0 }));
    this.pump(conversationId);
  }

  discard(conversationId: string, clientMessageId: string) {
    this.firstAttemptAt.delete(clientMessageId);
    this.set(removePending(this.state, conversationId, clientMessageId));
    this.pump(conversationId);
  }

  private pump(conversationId: string) {
    if (this.disposed || this.sending.has(conversationId) || this.sendTimers.has(conversationId)) return;
    const conversation = this.state.conversations[conversationId];
    const item = conversation && nextToSend(conversation.pending);
    if (!item) return;
    this.sending.add(conversationId);
    if (!this.firstAttemptAt.has(item.clientMessageId)) this.firstAttemptAt.set(item.clientMessageId, this.now());
    this.set(updatePending(this.state, conversationId, item.clientMessageId, { state: "sending", attempts: item.attempts + 1 }));
    void this.api.send(conversationId, { clientMessageId: item.clientMessageId, body: item.body, replyToMessageId: item.replyTo?.id }).then(
      ({ message }) => {
        this.sending.delete(conversationId);
        this.firstAttemptAt.delete(item.clientMessageId);
        // The event for this message may already have been applied; merging is by id.
        let reduced = applyOwnMessage(this.state, message, this.atBottom.get(conversationId) ?? true);
        reduced = { state: removePending(reduced.state, conversationId, item.clientMessageId), effects: reduced.effects };
        this.apply(reduced);
        this.pump(conversationId);
      },
      (error) => {
        this.sending.delete(conversationId);
        const attempts = item.attempts + 1;
        const failure = classifySendFailure(error, attempts);
        const started = this.firstAttemptAt.get(item.clientMessageId) ?? this.now();
        if (failure.kind === "retry" && this.now() - started + failure.delayMs <= SEND_RETRY_WINDOW_MS) {
          // It stays "sending" and holds its place; the ones behind it wait.
          this.sendTimers.set(conversationId, this.later(() => {
            this.sendTimers.delete(conversationId);
            this.pump(conversationId);
          }, failure.delayMs));
          return;
        }
        this.firstAttemptAt.delete(item.clientMessageId);
        const message = failure.kind === "fail" ? failure.message : failure.kind === "signedOut" ? "You were signed out before this was sent." : "Couldn’t reach the server.";
        this.set(updatePending(this.state, conversationId, item.clientMessageId, { state: "failed", error: message }));
        if (failure.kind === "signedOut") {
          this.onSignedOut?.();
          return;
        }
        this.pump(conversationId);
      },
    );
  }

  // ---- changing and removing messages ---------------------------------------------------

  async edit(conversationId: string, messageId: string, body: string) {
    const { message } = await this.api.edit(conversationId, messageId, body.trim());
    this.apply(applyOwnMessage(this.state, message, this.atBottom.get(conversationId) ?? true));
  }

  async deleteForEveryone(conversationId: string, messageId: string) {
    const { message } = await this.api.deleteForEveryone(conversationId, messageId);
    this.apply(applyOwnMessage(this.state, message, this.atBottom.get(conversationId) ?? true));
  }

  async deleteForMe(conversationId: string, messageId: string) {
    const { hideRev, unreadCount } = await this.api.deleteForMe(conversationId, messageId);
    this.apply(removeMessageLocally(this.state, conversationId, messageId, hideRev, unreadCount));
  }

  // ---- reading and typing ---------------------------------------------------------------

  /**
   * The person has seen the conversation up to `seq`. The count updates at once; the
   * server is told shortly after, once, with the furthest position reached.
   */
  markRead(conversationId: string, seq: number) {
    const conversation = this.state.conversations[conversationId];
    if (!conversation || seq <= conversation.summary.readSeq) return;
    this.set(markReadLocally(this.state, conversationId, seq));
    this.readTargets.set(conversationId, Math.max(this.readTargets.get(conversationId) ?? 0, seq));
    if (this.readTimers.has(conversationId)) return;
    this.readTimers.set(conversationId, this.later(() => {
      this.readTimers.delete(conversationId);
      const target = this.readTargets.get(conversationId) ?? 0;
      this.readTargets.delete(conversationId);
      void this.api.markRead(conversationId, target).then(
        ({ readSeq, unreadCount }) => {
          this.apply(applyEvent(this.state, { type: "conversation.read", conversationId, userId: this.me.id, readSeq, unreadCount }, this.now()));
        },
        (error) => {
          // The position is still ahead locally; the next read or the next list fixes it.
          this.handleSignedOut(error);
        },
      );
    }, READ_DEBOUNCE_MS));
  }

  /** Call while the person is writing. The server is told at most once every few seconds. */
  typing(conversationId: string) {
    const last = this.lastTypingAt.get(conversationId) ?? 0;
    if (this.now() - last < TYPING_INTERVAL_MS || !this.state.conversations[conversationId]?.summary.canSend) return;
    this.lastTypingAt.set(conversationId, this.now());
    void this.api.typing(conversationId).catch(() => undefined);
  }

  private scheduleTypingExpiry() {
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
    const expiry = nextTypingExpiry(this.state);
    if (expiry === null) return;
    this.typingTimer = setTimeout(() => {
      this.typingTimer = null;
      this.set(expireTyping(this.state, this.now()));
    }, Math.max(expiry - this.now(), 0) + 20);
  }

  // ---- conversations ---------------------------------------------------------------------

  private take(result: { conversation: ChatConversation; members?: ChatMember[] }): ChatConversation {
    this.apply(applySummary(this.state, result.conversation, result.members));
    return result.conversation;
  }

  /** Returns the direct message with someone, creating it if there is none. */
  async openDM(userId: string) {
    return this.take(await this.api.openDM(userId));
  }

  async createGroup(name: string, memberIds: string[]) {
    return this.take(await this.api.createGroup(name, memberIds));
  }

  async rename(conversationId: string, patch: { name?: string; topic?: string }) {
    return this.take(await this.api.updateConversation(conversationId, patch));
  }

  async addMembers(conversationId: string, userIds: string[]) {
    return this.take(await this.api.addMembers(conversationId, userIds));
  }

  async removeMember(conversationId: string, userId: string) {
    await this.api.removeMember(conversationId, userId);
    if (userId === this.me.id) {
      this.set(removeConversation(this.state, conversationId));
      this.forget(conversationId);
    } else {
      void this.fetchSummary(conversationId);
    }
  }

  leave(conversationId: string) {
    return this.removeMember(conversationId, this.me.id);
  }

  async deleteConversation(conversationId: string) {
    await this.api.deleteConversation(conversationId);
    this.set(removeConversation(this.state, conversationId));
    this.forget(conversationId);
  }

  async setArchived(conversationId: string, archived: boolean) {
    this.take(await this.api.setArchived(conversationId, archived));
  }

  /** Empties a conversation for me only. A direct message also leaves my list. */
  async clear(conversationId: string) {
    const kind = this.state.conversations[conversationId]?.summary.kind;
    await this.api.clearConversation(conversationId);
    if (kind === "dm") {
      this.set(removeConversation(this.state, conversationId));
      this.forget(conversationId);
    } else {
      await this.fetchSummary(conversationId);
    }
  }

  async setShareReadStatus(shareReadStatus: boolean) {
    const { settings } = await this.api.updateSettings({ shareReadStatus });
    this.set(setSettings(this.state, settings));
    this.refreshList();
  }

  // ---- tree layout -----------------------------------------------------------------------

  private takeLayout(layout: TreeLayout): TreeLayout {
    this.set(setLayout(this.state, layout));
    return layout;
  }

  async loadLayout(treeId: string) {
    return this.takeLayout((await this.api.treeLayout(treeId)).layout);
  }

  async saveLayout(treeId: string, layout: { categories: string[]; items: Array<{ kind: "voice" | "text"; id: string; categoryId?: string }> }) {
    return this.takeLayout((await this.api.saveTreeLayout(treeId, layout)).layout);
  }

  async createCategory(treeId: string, name: string) {
    const { category } = await this.api.createCategory(treeId, name);
    await this.loadLayout(treeId);
    return category;
  }

  async renameCategory(treeId: string, categoryId: string, name: string) {
    await this.api.renameCategory(treeId, categoryId, name);
    await this.loadLayout(treeId);
  }

  async deleteCategory(treeId: string, categoryId: string) {
    await this.api.deleteCategory(treeId, categoryId);
    await this.loadLayout(treeId);
  }

  async createTextNest(treeId: string, name: string, categoryId?: string) {
    const { conversation } = await this.api.createTextNest(treeId, name, categoryId);
    this.apply(applySummary(this.state, conversation));
    await this.loadLayout(treeId);
    return conversation;
  }

  // ---- ending ----------------------------------------------------------------------------

  /** Stops everything. With `signingOut`, unsent messages are discarded too. */
  dispose(signingOut = false) {
    this.disposed = true;
    for (const timer of [this.listTimer, this.typingTimer, ...this.changesTimers.values(), ...this.sendTimers.values(), ...this.readTimers.values()]) {
      if (timer) clearTimeout(timer);
    }
    this.listeners.clear();
    if (signingOut && this.storage) clearOutbox(this.storage, this.me.id);
  }
}
