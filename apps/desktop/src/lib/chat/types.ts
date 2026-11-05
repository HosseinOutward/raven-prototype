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

/**
 * Something a message carries besides its text. `kind` says how it is shown (an image
 * now; a gif, sticker, video or file later) and `source` where its bytes come from
 * (`stored` on the server now; `peer` later). Both are open: a newer Raven may send
 * kinds and sources this one does not know.
 */
export interface ChatAttachment {
  id: string;
  kind: string;
  source: string;
  /** Of the `full` variant. */
  contentType: string;
  /** Bytes of the `full` variant. */
  size: number;
  name?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  /** A ThumbHash, base64: a blurred stand-in shown before the image loads. */
  placeholder?: string;
  /** What can be fetched, for example ["full", "preview"]. */
  variants: string[];
  meta?: Record<string, unknown>;
}

/** All a list or a quote needs to say what a message holds ("Photo"). */
export interface ChatAttachmentSummary {
  kind: string;
}

/** The quoted line above a reply. */
export interface ChatReplyRef {
  id: string;
  seq?: number;
  senderId?: string;
  senderName?: string;
  excerpt?: string;
  deleted?: boolean;
  attachments?: ChatAttachmentSummary[];
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

export interface ChatReaction {
  emoji: string;
  count: number;
  userIds: string[];
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
  /** The text, or the caption when there are attachments. May be empty then. */
  body: string;
  attachments?: ChatAttachment[];
  reactions?: ChatReaction[];
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
  attachments?: ChatAttachmentSummary[];
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
  /** The other person in a direct message deleted their account. */
  peerDeleted?: boolean;
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
  /** When that position last moved (ISO). Absent with `peerReadSeq`. */
  peerReadAt?: string;
  hideRev: number;
  visibleFromSeq: number;
  archived: boolean;
  notify?: import("./notify").NotifyMode;
  createdAt: string;
}

export interface ChatViewerState {
  readSeq: number;
  hideRev: number;
  visibleFromSeq: number;
}

/** Where you take part in read receipts. Each switch works both ways. */
export interface ChatSettings {
  /** The old name of `readDm`, kept in step by the server for older clients. */
  shareReadStatus: boolean;
  readDm: boolean;
  readGroup: boolean;
  readPrivateSpace: boolean;
  readPublicSpace: boolean;
}

export interface ChatSeenReader {
  userId: string;
  username: string;
  displayName: string;
  /** When their read position reached the last message (ISO). */
  at: string;
}

/** Who has seen the conversation's last message (`seq`), not counting you or its sender. */
export interface ChatSeen {
  seq: number;
  readers: ChatSeenReader[];
  /** How far the furthest other reader has read: every message up to it is seen by someone. */
  readSeq?: number;
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
  | "conversation.seen"
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
  readAt?: string;
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

/** What plan 02's native preparation returned for one picked, pasted or dropped file. */
export interface PreparedVariant {
  variant: string;
  contentType: string;
  size: number;
}

export interface PreparedAttachment {
  /** The folder on this computer that holds its variants until it is sent. */
  handle: string;
  kind: string;
  contentType: string;
  size: number;
  name: string;
  width: number;
  height: number;
  placeholder: string;
  /** For the tray only (a still preview of a moving image). Not sent. */
  animated: boolean;
  variants: PreparedVariant[];
}

/**
 * One attachment of an unsent message, and how far sending it got. Each step is
 * recorded, so a retry or a restart carries on where it stopped.
 */
export interface PendingAttachment {
  handle: string;
  /** Lets the server recognise a repeated create. One per attachment, never reused. */
  clientUploadId: string;
  kind: string;
  description: PreparedAttachment;
  /** Set once the server has created it. */
  attachmentId?: string;
  /** Variants the server has. */
  uploaded: string[];
}

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
  attachments?: PendingAttachment[];
  replyTo?: ChatReplyRef;
  createdAt: string;
  state: "queued" | "sending" | "failed";
  /** Why it failed, in words the person can act on. */
  error?: string;
  attempts: number;
  /** Its uploads were started over once because the server had let them go. */
  reuploaded?: boolean;
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
  /** Who has seen the last message. Absent until fetched. */
  seen?: ChatSeen;
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
  | { type: "fetchList" }
  | { type: "fetchSeen"; conversationId: string };

export interface Reduced {
  state: ChatState;
  effects: ChatEffect[];
}
