// Pure parts of the Workshop's port sharing: the share list built from events, and the
// sentences shown to the user. No Tauri, no network, so they are unit tested.

export type WorkshopPlaceKind = "nest" | "room";
export type WorkshopProtocol = "tcp" | "udp" | "both";

/** One shared port, as the server describes it. */
export interface WorkshopShare {
  id: string;
  name: string;
  placeKind: WorkshopPlaceKind;
  placeId: string;
  publisherId: string;
  protocol: WorkshopProtocol;
  port: number;
  /** True when everyone in the place may use it; otherwise `audience` lists who. */
  everyone: boolean;
  audience: string[];
  expiresAt: string;
  /** The sharer’s Raven is connected to the relay. */
  online: boolean;
  /** Who is connected right now. */
  consumers: string[];
  udpDropped: number;
}

export interface WorkshopLimits {
  maxShares: number;
  maxConsumers: number;
  maxFlows: number;
  shareMbps: number;
  dailyBytes: number;
  defaultMinutes: number;
  maxMinutes: number;
}

export interface WorkshopConfig {
  enabled: boolean;
  endpoints: string[];
  limits: WorkshopLimits;
}

export type EndReason = "stopped" | "expired" | "publisher_offline" | "left_place" | "relay_restarted";

/** Applies a `workshop.share.*` event to the shares of one place. */
export function applyShareEvent(
  shares: WorkshopShare[],
  type: string,
  share: WorkshopShare,
): WorkshopShare[] {
  const rest = shares.filter((item) => item.id !== share.id);
  if (type === "workshop.share.ended") return rest;
  if (type === "workshop.share.added" || type === "workshop.share.updated") {
    return [...rest, share].sort((a, b) => a.id.localeCompare(b.id));
  }
  return shares;
}

/** Whether a person may see and use a share: the publisher, everyone, or a picked person. */
export function mayUseShare(share: WorkshopShare, userId: string): boolean {
  return share.publisherId === userId || share.everyone || share.audience.includes(userId);
}

export function protocolLabel(protocol: WorkshopProtocol): string {
  return protocol === "both" ? "TCP and UDP" : protocol.toUpperCase();
}

/** "1 h 5 min left", "12 min left", "less than a minute left", or "ended". */
export function timeLeft(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "ended";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute left";
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h left` : `${hours} h ${rest} min left`;
}

/** Why a share or a connection ended, as a full sentence. */
export function endReasonSentence(reason: string | undefined, role: "publisher" | "consumer"): string {
  switch (reason) {
    case "stopped":
      return role === "publisher" ? "You stopped sharing this port." : "You disconnected from this port.";
    case "expired":
      return "This share reached its time limit and ended.";
    case "publisher_offline":
      return "The person sharing this port went offline, so the share ended.";
    case "left_place":
      return "You are no longer in the place this port was shared in, so access ended.";
    case "relay_restarted":
      return "The relay restarted. Share the port again.";
    default:
      return reason?.startsWith("connection_lost")
        ? "The connection to the relay was lost, so this port stopped working."
        : "The connection to this port ended.";
  }
}

/** The route as one sentence, plus who can read the traffic. Until end-to-end encryption exists. */
export function routeSentence(route: string): string {
  return `${route}. The connection to the relay is encrypted, but the relay’s operator, and any CDN on the route that ends TLS, can read the forwarded bytes.`;
}

/** Bytes as a short readout: "820 B", "14 KB", "3.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** What a consumer copies to reach a share. */
export function localAddress(port: number): string {
  return `127.0.0.1:${port}`;
}
