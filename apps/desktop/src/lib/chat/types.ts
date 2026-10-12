// What the server sends for text chat, and what the client keeps about it.
// The wire shapes mirror services/api/internal/http/chat.go.

export type ChatKind = "dm" | "group" | "nest";

export interface ChatUser {
  id: string;
  username: string;
  displayName: string;
}

export interface ChatMember extends ChatUser {
  role: "owner" | "member";
  joinedAt: string;
}

/** The quoted line above a reply. */
export interface ChatReplyRef {
  id: string;
  seq?: number;
  senderId?: string;
  senderName?: string;
  excerpt?: string;
  deleted?: boolean;
  /** This reader may not see the original (it predates them, or they removed it). */
  unavailable?: boolean;
}

/** What a system line says happened. */
export interface ChatSystemPayload {
  event: "group_created" | "members_added" | "member_left" | "member_removed" | "renamed" | "topic_changed" | string;
  name?: string;
  user?: ChatUser;
  users?: ChatUser[];
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  /** When it was created within the conversation. The order and paging key. */
  seq: number;
  /** The conversation seq of its last change (an edit or a delete). */
  changedSeq: number;
  senderId: string;
  senderName: string;
  clientMessageId: string;
  kind: "text" | "system";
  body: string;
  replyTo?: ChatReplyRef;
  system?: ChatSystemPayload;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
}

export interface ChatMessagePreview {
  id: string;
  seq: number;
  senderId: string;
  senderName: string;
  kind: "text" | "system";
  excerpt: string;
  system?: ChatSystemPayload;
  deleted?: boolean;
  createdAt: string;
}

/** A conversation as the signed-in person sees it. */
export interface ChatConversation {
  id: string;
  kind: ChatKind;
  name: string;
  topic: string;
  treeId?: string;
  peer?: ChatUser;
  role: string;
  canSend: boolean;
  canManage: boolean;
  memberCount: number;
  lastSeq: number;
  lastActivityMs: number;
  lastMessage?: ChatMessagePreview;
  /** Counted up to UNREAD_CAP; at the cap it means "that many or more". */
  unreadCount: number;
  readSeq: number;
  /** How far the other person in a direct message has read. Absent unless both share it. */
  peerReadSeq?: number;
  hideRev: number;
  visibleFromSeq: number;
  archived: boolean;
  createdAt: string;
}

export interface ChatViewerState {
  readSeq: number;
  hideRev: number;
  visibleFromSeq: number;
}

export interface ChatSettings {
  shareReadStatus: boolean;
}

export interface ChatPage {
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  /** Everything in the conversation up to this seq is reflected in `messages`. */
  asOfSeq: number;
  me: ChatViewerState;
}

export interface ChatChanges {
  messages: ChatMessage[];
  /** Too much changed to list: reload the newest page instead. */
  reset: boolean;
  asOfSeq: number;
  me: ChatViewerState;
}

export type ChatEventType =
  | "message.created"
  | "message.updated"
  | "conversation.bump"
  | "message.hidden"
  | "conversation.read"
  | "conversation.changed"
  | "conversation.removed"
  | "typing"
  | "settings.changed";

export interface ChatEvent {
  type: ChatEventType | string;
  conversationId: string;
  seq?: number;
  message?: ChatMessage;
  messageId?: string;
  userId?: string;
  userName?: string;
  readSeq?: number;
  unreadCount?: number;
  hideRev?: number;
  at?: string;
}

export interface TreeCategory {
  id: string;
  name: string;
  position: number;
}

export interface TreeLayoutItem {
  kind: "voice" | "text";
  id: string;
  categoryId?: string;
  position: number;
}

export interface TreeLayout {
  treeId: string;
  categories: TreeCategory[];
  items: TreeLayoutItem[];
}

// ---- client-side state ---------------------------------------------------------

/** The server stops counting unread messages here; show "99+". */
export const UNREAD_CAP = 100;

/**
 * A message the person has sent that the server has not acknowledged yet.
 *   queued   waiting its turn (messages to one conversation go one at a time)
 *   sending  the request is out, or it failed in a way worth retrying and will go again
 *   failed   it will not be retried without the person asking
 */
export interface PendingMessage {
  clientMessageId: string;
  conversationId: string;
  body: string;
  replyTo?: ChatReplyRef;
  createdAt: string;
  state: "queued" | "sending" | "failed";
  /** Why it failed, in words the person can act on. */
  error?: string;
  attempts: number;
}

export interface TypingPerson {
  name: string;
  /** When to stop showing it if nothing more is heard, in epoch milliseconds. */
  until: number;
}

export type WindowLoad = "idle" | "initial" | "older" | "newer";

/** One conversation: its list entry and, when open, a window of its messages. */
export interface ConversationState {
  summary: ChatConversation;
  members: ChatMember[];
  /** True once a page of messages has been loaded into `messages`. */
  loaded: boolean;
  /** Ascending by seq. A contiguous run of what the person may see, not the whole history. */
  messages: ChatMessage[];
  /**
   * The window reflects every change up to this seq. It is used only to notice a gap:
   * an event further ahead than the next seq means something was missed.
   */
  syncedSeq: number;
  hasMoreBefore: boolean;
  /** False when the window reaches the newest message. */
  hasMoreAfter: boolean;
  loading: WindowLoad;
  pending: PendingMessage[];
  typing: Record<string, TypingPerson>;
}

export type ChatConnection = "connecting" | "live" | "offline";

export interface ChatState {
  me: string;
  connection: ChatConnection;
  /** True once the conversation list has been fetched at least once. */
  listLoaded: boolean;
  conversations: Record<string, ConversationState>;
  settings: ChatSettings;
  layouts: Record<string, TreeLayout>;
}

/** Work the store must do as a consequence of a state change. */
export type ChatEffect =
  | { type: "fetchChanges"; conversationId: string; after: number }
  | { type: "fetchSummary"; conversationId: string }
  | { type: "reload"; conversationId: string }
  | { type: "fetchList" };

export interface Reduced {
  state: ChatState;
  effects: ChatEffect[];
}
