import { useEffect, useMemo, useState } from "react";
import { Cable, Copy, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  connectShare,
  disconnectShare,
  dismissSession,
  extendShare,
  publishShare,
  sessionFor,
  stopShare,
  usePlaceShares,
  usePortSharingEnabled,
  useShareSessions,
  useWorkshopConfig,
  type ShareSession,
} from "@/lib/workshop";
import {
  endReasonSentence,
  formatBytes,
  localAddress,
  mayUseShare,
  protocolLabel,
  routeSentence,
  timeLeft,
  type WorkshopConfig,
  type WorkshopPlaceKind,
  type WorkshopProtocol,
  type WorkshopShare,
} from "@/lib/workshopState";

export interface PortsPerson {
  id: string;
  name: string;
}

const DURATIONS = [30, 60, 120, 240, 720];

function durationLabel(minutes: number) {
  return minutes < 60 ? `${minutes} minutes` : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
}

/**
 * The "Ports" control in a call's or a room's header. It shows only when the device switch
 * (Settings › Workshop) is on and this server has port sharing turned on.
 */
export function PortsControl({
  placeKind,
  placeId,
  userId,
  people,
}: {
  placeKind: WorkshopPlaceKind;
  placeId: string;
  userId: string | undefined;
  /** Who can be picked as an audience, other than you. */
  people: PortsPerson[];
}) {
  const switchOn = usePortSharingEnabled();
  const config = useWorkshopConfig(switchOn);
  const active = switchOn && config?.enabled === true;
  const shares = usePlaceShares(placeKind, placeId, active);
  if (!active || !config || !userId) return null;
  const mine = shares.filter((share) => mayUseShare(share, userId));
  return (
    <Popover>
      <Tooltip label="Share a local port" side="bottom">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="xs" aria-label="Ports">
            <Cable className="h-4 w-4" />
            Ports{mine.length > 0 ? ` · ${mine.length}` : ""}
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="max-h-[70vh] w-[26rem] overflow-y-auto">
        <PortsPanel config={config} placeKind={placeKind} placeId={placeId} userId={userId} shares={mine} people={people} />
      </PopoverContent>
    </Popover>
  );
}

function PortsPanel({
  config,
  placeKind,
  placeId,
  userId,
  shares,
  people,
}: {
  config: WorkshopConfig;
  placeKind: WorkshopPlaceKind;
  placeId: string;
  userId: string;
  shares: WorkshopShare[];
  people: PortsPerson[];
}) {
  const sessions = useShareSessions();
  const [now, setNow] = useState(() => Date.now());
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const names = useMemo(() => new Map(people.map((person) => [person.id, person.name])), [people]);
  const nameOf = (id: string) => (id === userId ? "You" : names.get(id) ?? "Someone");
  // A share that ended while this device held it stays here until dismissed, so the reason is read.
  const ended = [...sessions.values()].filter((session) => session.state === "ended" && !shares.some((share) => share.id === session.shareId));

  const route = [...sessions.values()].find((session) => session.route && session.state === "live")?.route
    ?? (config.endpoints.find((endpoint) => endpoint.startsWith("quic://"))?.replace("quic://", "QUIC with TLS 1.3 to "));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title-sm font-semibold">Shared ports</h2>
        {!sharing ? (
          <Button size="xs" variant="secondary" onClick={() => setSharing(true)}>
            <Plus className="h-3.5 w-3.5" />
            Share a port
          </Button>
        ) : null}
      </div>

      {sharing ? (
        <ShareForm
          config={config}
          placeKind={placeKind}
          placeId={placeId}
          people={people}
          onDone={() => setSharing(false)}
        />
      ) : null}

      {shares.length === 0 && ended.length === 0 && !sharing ? (
        <p className="text-small text-muted-foreground">Nothing is shared here. A shared port lets the people you choose reach a program on your computer, as if it were on theirs.</p>
      ) : null}

      {shares.map((share) => (
        <ShareRow key={share.id} share={share} userId={userId} nameOf={nameOf} now={now} config={config} sessions={sessions} />
      ))}

      {ended.map((session) => (
        <div key={`${session.role}:${session.shareId}`} className="flex items-start justify-between gap-3 rounded-card bg-secondary/50 px-3 py-2">
          <p className="text-small" role="status">{endReasonSentence(session.reason, session.role)}</p>
          <Button size="xs" variant="ghost" onClick={() => dismissSession(session.role, session.shareId)}>Dismiss</Button>
        </div>
      ))}

      <p className="text-caption text-muted-foreground">
        {route ? routeSentence(route) : "The connection to the relay is encrypted, but the relay’s operator, and any CDN on the route that ends TLS, can read the forwarded bytes."}
      </p>
    </div>
  );
}

function ShareRow({
  share,
  userId,
  nameOf,
  now,
  config,
  sessions,
}: {
  share: WorkshopShare;
  userId: string;
  nameOf: (id: string) => string;
  now: number;
  config: WorkshopConfig;
  sessions: ReadonlyMap<string, ShareSession>;
}) {
  const mine = share.publisherId === userId;
  const publishing = sessionFor(sessions, "publisher", share.id);
  const using = sessionFor(sessions, "consumer", share.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = mine ? publishing : using;
  const audience = share.everyone ? "everyone here" : share.audience.map(nameOf).join(", ");

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn’t work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-card bg-secondary/50 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-body font-medium">{share.name}</div>
          <div className="text-caption text-muted-foreground">
            {protocolLabel(share.protocol)} · port {share.port} · {mine ? "yours" : nameOf(share.publisherId)} · {audience} · {timeLeft(share.expiresAt, now)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {mine ? (
            <>
              <Tooltip label={`Add up to ${Math.floor(config.limits.maxMinutes / 60)} hours from now`} side="bottom">
                <Button size="xs" variant="secondary" disabled={busy} onClick={() => void run(() => extendShare(share.id, 60))}>
                  Extend 1 h
                </Button>
              </Tooltip>
              <Button size="xs" variant="secondary" disabled={busy} onClick={() => void run(() => stopShare(share.id))}>Stop</Button>
            </>
          ) : using?.state === "live" ? (
            <Button size="xs" variant="secondary" disabled={busy} onClick={() => void run(() => disconnectShare(share.id))}>Disconnect</Button>
          ) : (
            <Button size="xs" disabled={busy || !share.online} onClick={() => void run(() => connectShare(config, share))}>Connect</Button>
          )}
        </div>
      </div>

      {!mine && using?.state === "live" && using.localPort ? (
        <div className="mt-2 flex items-center gap-2 text-small">
          <span className="font-mono">{localAddress(using.localPort)}</span>
          <Tooltip label="Copy the address" side="top">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Copy the address"
              onClick={() => void navigator.clipboard.writeText(localAddress(using.localPort!)).then(
                () => toast({ title: "Address copied.", tone: "success" }),
                () => toast({ title: "Couldn’t copy the address.", tone: "error" }),
              )}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <span className="text-muted-foreground">Programs on this computer reach it here.</span>
        </div>
      ) : null}

      {mine && share.consumers.length > 0 ? (
        <p className="mt-2 text-caption text-muted-foreground">Connected: {share.consumers.map(nameOf).join(", ")}.</p>
      ) : null}
      {mine && !share.online && !publishing ? (
        <p className="mt-2 text-caption text-warning">This share isn’t connected to the relay yet.</p>
      ) : null}

      {live?.state === "live" ? <Readout session={live} /> : null}
      {live?.notice ? <p className="mt-2 text-caption text-warning" role="status">{live.notice}</p> : null}
      {error ? <p className="mt-2 text-caption text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}

function Readout({ session }: { session: ShareSession }) {
  return (
    <p className="mt-2 text-caption text-muted-foreground" aria-label="Traffic">
      <span className="font-mono">{formatBytes(session.bytesUp)} in · {formatBytes(session.bytesDown)} out</span>
      {session.flows > 0 ? ` · ${session.flows} open` : ""}
      {session.udpDropped > 0 ? ` · ${session.udpDropped} UDP packets didn’t fit and were dropped` : ""}
    </p>
  );
}

function ShareForm({
  config,
  placeKind,
  placeId,
  people,
  onDone,
}: {
  config: WorkshopConfig;
  placeKind: WorkshopPlaceKind;
  placeId: string;
  people: PortsPerson[];
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<WorkshopProtocol>("tcp");
  const [port, setPort] = useState("");
  const [everyone, setEveryone] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [minutes, setMinutes] = useState(Math.min(config.limits.defaultMinutes, config.limits.maxMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const durations = DURATIONS.filter((value) => value <= config.limits.maxMinutes);
  const portNumber = Number(port);
  const valid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535 && (everyone || picked.length > 0);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await publishShare(config, { placeKind, placeId, name: name.trim(), protocol, port: portNumber, audience: everyone ? "all" : picked, minutes });
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The port wasn’t shared.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-card bg-secondary/50 p-3">
      <label className="block space-y-1">
        <span className="text-small">Name</span>
        <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} placeholder="Minecraft server" autoFocus />
      </label>
      <div className="space-y-1">
        <span className="text-small" id="ports-protocol">Protocol</span>
        <div role="radiogroup" aria-labelledby="ports-protocol" className="flex rounded-control bg-background/60 p-0.5">
          {(["tcp", "udp", "both"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={protocol === value}
              onClick={() => setProtocol(value)}
              className={cn("h-7 flex-1 rounded-chip text-small transition-colors", protocol === value ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {protocolLabel(value)}
            </button>
          ))}
        </div>
      </div>
      <label className="block space-y-1">
        <span className="text-small">Port on this computer</span>
        <Input value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" placeholder="25565" />
        <span className="block text-caption text-muted-foreground">
          Only a program listening on 127.0.0.1 or ::1 here can be shared. With TCP and UDP together, the same number is used for both.
        </span>
      </label>
      <div className="space-y-1">
        <span className="text-small" id="ports-audience">Who can connect</span>
        <div role="radiogroup" aria-labelledby="ports-audience" className="flex rounded-control bg-background/60 p-0.5">
          {([[true, "Everyone here"], [false, "Pick people"]] as const).map(([value, label]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={everyone === value}
              onClick={() => setEveryone(value)}
              className={cn("h-7 flex-1 rounded-chip text-small transition-colors", everyone === value ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {label}
            </button>
          ))}
        </div>
        {!everyone ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {people.length === 0 ? <p className="text-caption text-muted-foreground">Nobody else is here to pick.</p> : null}
            {people.map((person) => {
              const on = picked.includes(person.id);
              return (
                <button
                  key={person.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPicked((current) => on ? current.filter((id) => id !== person.id) : [...current, person.id])}
                  className={cn("h-7 rounded-chip px-2.5 text-small transition-colors", on ? "bg-primary text-primary-foreground" : "bg-background/60 text-muted-foreground hover:text-foreground")}
                >
                  {person.name}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="space-y-1">
        <span className="text-small" id="ports-duration">Share for</span>
        <Select value={String(minutes)} onValueChange={(value) => setMinutes(Number(value))}>
          <SelectTrigger aria-labelledby="ports-duration">
            <SelectValue>{durationLabel(minutes)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {durations.map((value) => (
              <SelectItem key={value} value={String(value)}>{durationLabel(value)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="block text-caption text-muted-foreground">
          It ends sooner if you stop it, leave, or close Raven. This server allows up to {config.limits.maxMinutes / 60} hours.
        </span>
      </div>
      {error ? <p className="text-small text-destructive" role="alert">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!valid || busy}>Share</Button>
      </div>
    </form>
  );
}
