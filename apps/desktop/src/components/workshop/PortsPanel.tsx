import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Cable, Copy, LockKeyhole, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  routeParts,
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
  return minutes < 60 ? `${minutes} min` : `${minutes / 60} h`;
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
      <Tooltip label="Shared ports" side="bottom">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="xs" aria-label="Ports">
            <Cable className="h-4 w-4" />
            Ports{mine.length > 0 ? <span className="tabular-nums text-muted-foreground">{mine.length}</span> : null}
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="max-h-[70vh] w-[24rem] overflow-y-auto p-0">
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
    ?? config.endpoints.find((endpoint) => endpoint.startsWith("quic://"))?.replace("quic://", "QUIC with TLS 1.3 to ");

  if (sharing) {
    return (
      <ShareForm
        config={config}
        placeKind={placeKind}
        placeId={placeId}
        people={people}
        onDone={() => setSharing(false)}
      />
    );
  }

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-body font-medium">Shared ports</h2>
        <Button size="xs" variant="secondary" onClick={() => setSharing(true)}>
          <Plus className="h-3.5 w-3.5" />
          Share a port
        </Button>
      </div>

      {shares.length === 0 && ended.length === 0 ? (
        <p className="py-4 text-center text-small text-muted-foreground">No ports shared here yet.</p>
      ) : (
        <div className="divide-y divide-border/70 overflow-hidden rounded-card bg-secondary/50">
          {shares.map((share) => (
            <ShareRow key={share.id} share={share} userId={userId} nameOf={nameOf} now={now} config={config} sessions={sessions} />
          ))}
          {ended.map((session) => (
            <div key={`${session.role}:${session.shareId}`} className="flex items-center justify-between gap-2 px-3 py-2">
              <p className="text-small text-muted-foreground" role="status">{endReasonSentence(session.reason, session.role)}</p>
              <Tooltip label="Dismiss" side="top">
                <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={() => dismissSession(session.role, session.shareId)}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            </div>
          ))}
        </div>
      )}

      <RouteFooter route={route} />
    </div>
  );
}

/** Which way the bytes go and who can read them. Until end-to-end encryption exists. */
function RouteFooter({ route }: { route: string | undefined }) {
  const parts = route ? routeParts(route) : null;
  return (
    <div className="flex items-start gap-2 border-t border-border/70 pt-3 text-caption text-muted-foreground">
      <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
      <div className="min-w-0 space-y-0.5">
        {parts ? (
          <div className="truncate">
            <span className="text-foreground">{parts.transport}</span> to relay <span className="font-mono">{parts.endpoint}</span>
          </div>
        ) : null}
        <div>Not end-to-end encrypted. The relay and any CDN that ends TLS can read forwarded traffic.</div>
      </div>
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
  // The server sets the end to "this many minutes from now", so adding an hour is the time left plus 60.
  const remainingMinutes = Math.max(0, Math.ceil((Date.parse(share.expiresAt) - now) / 60_000));
  const audience = share.everyone ? "Everyone" : share.audience.map(nameOf).join(", ");

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
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {share.name ? <span className="truncate text-body font-medium">{share.name}</span> : null}
            <span className={cn("shrink-0 font-mono", share.name ? "text-caption text-muted-foreground" : "text-small font-medium")}>{protocolLabel(share.protocol)} {share.port}</span>
          </div>
          <div className="truncate text-caption text-muted-foreground">
            {mine ? "You" : nameOf(share.publisherId)} · {audience} · <span className="tabular-nums">{timeLeft(share.expiresAt, now)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {mine ? (
            <>
              <Tooltip label={remainingMinutes >= config.limits.maxMinutes ? `At the ${config.limits.maxMinutes / 60} h limit` : "Add 1 hour"} side="top">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy || remainingMinutes >= config.limits.maxMinutes}
                  onClick={() => void run(() => extendShare(share.id, Math.min(remainingMinutes + 60, config.limits.maxMinutes)))}
                >
                  +1 h
                </Button>
              </Tooltip>
              <Button size="xs" variant="secondary" disabled={busy} onClick={() => void run(() => stopShare(share.id))}>Stop</Button>
            </>
          ) : using?.state === "live" ? (
            <Button size="xs" variant="secondary" disabled={busy} onClick={() => void run(() => disconnectShare(share.id))}>Disconnect</Button>
          ) : (
            <Tooltip label={share.online ? `Listen on 127.0.0.1:${share.port}` : "The sharer isn’t connected to the relay"} side="top">
              <span>
                <Button size="xs" disabled={busy || !share.online} onClick={() => void run(() => connectShare(config, share))}>Connect</Button>
              </span>
            </Tooltip>
          )}
        </div>
      </div>

      {!mine && using?.state === "live" && using.localPort ? <LocalAddress port={using.localPort} /> : null}

      {mine && !share.online && !publishing ? (
        <p className="mt-1.5 text-caption text-warning">Not connected to the relay yet.</p>
      ) : null}

      {live?.state === "live" ? (
        <Readout session={live} connected={mine ? share.consumers.map(nameOf) : null} />
      ) : null}
      {live?.notice ? <p className="mt-1.5 text-caption text-warning" role="status">{live.notice}</p> : null}
      {error ? <p className="mt-1.5 text-caption text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}

function LocalAddress({ port }: { port: number }) {
  const address = localAddress(port);
  const copy = () => void navigator.clipboard.writeText(address).then(
    () => toast({ title: "Address copied.", tone: "success" }),
    () => toast({ title: "Couldn’t copy the address.", tone: "error" }),
  );
  return (
    <div className="mt-2 flex items-center gap-1">
      <Input readOnly value={address} aria-label="Local address" className="h-8 font-mono text-small" onFocus={(event) => event.currentTarget.select()} />
      <Tooltip label="Copy" side="top">
        <Button size="icon-sm" variant="ghost" aria-label="Copy the address" onClick={copy}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
    </div>
  );
}

function Readout({ session, connected }: { session: ShareSession; connected: string[] | null }) {
  return (
    <p className="mt-1.5 flex flex-wrap gap-x-3 text-caption tabular-nums text-muted-foreground" aria-label="Traffic">
      {connected ? <span>{connected.length > 0 ? connected.join(", ") : "Nobody connected"}</span> : null}
      <span>↓ {formatBytes(session.bytesDown)}</span>
      <span>↑ {formatBytes(session.bytesUp)}</span>
      {session.flows > 0 ? <span>{session.flows} open</span> : null}
      {session.udpDropped > 0 ? <span className="text-warning">{session.udpDropped} UDP dropped (too large)</span> : null}
    </p>
  );
}

function Segmented<Id extends string>({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: { id: Id; label: string }[];
  selected: Id;
  onSelect: (id: Id) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-control bg-background/60 p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={selected === option.id}
          onClick={() => onSelect(option.id)}
          className={cn(
            "h-7 flex-1 rounded-chip px-2 text-small transition-colors",
            selected === option.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <span className="block text-caption text-muted-foreground">{label}</span>
      {children}
    </div>
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
    <form onSubmit={submit} className="space-y-3.5 p-3">
      <div className="flex items-center gap-1.5">
        <Tooltip label="Back" side="bottom">
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Back" onClick={onDone}>
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        <h2 className="text-body font-medium">Share a port</h2>
      </div>

      <div className="flex gap-2">
        <Field label="Port" className="w-24 shrink-0">
          <Input
            value={port}
            onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
            inputMode="numeric"
            placeholder="25565"
            aria-label="Port"
            className="font-mono"
            autoFocus
          />
        </Field>
        <Field label="Name" className="min-w-0 flex-1">
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} placeholder="Minecraft" aria-label="Name" />
        </Field>
      </div>

      <Field label="Protocol">
        <Segmented
          label="Protocol"
          options={[{ id: "tcp", label: "TCP" }, { id: "udp", label: "UDP" }, { id: "both", label: "TCP + UDP" }]}
          selected={protocol}
          onSelect={setProtocol}
        />
      </Field>

      <Field label="Who can connect">
        <Segmented
          label="Who can connect"
          options={[{ id: "all", label: "Everyone here" }, { id: "pick", label: "Pick people" }]}
          selected={everyone ? "all" : "pick"}
          onSelect={(id) => setEveryone(id === "all")}
        />
        {!everyone ? (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {people.length === 0 ? <p className="text-caption text-muted-foreground">Nobody else is here.</p> : null}
            {people.map((person) => {
              const on = picked.includes(person.id);
              return (
                <button
                  key={person.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPicked((current) => on ? current.filter((id) => id !== person.id) : [...current, person.id])}
                  className={cn("h-7 rounded-chip px-2.5 text-small transition-colors", on ? "bg-primary text-primary-foreground" : "bg-accent/60 text-muted-foreground hover:text-foreground")}
                >
                  {person.name}
                </button>
              );
            })}
          </div>
        ) : null}
      </Field>

      <Field label="Duration">
        <Segmented
          label="Duration"
          options={durations.map((value) => ({ id: String(value), label: durationLabel(value) }))}
          selected={String(minutes)}
          onSelect={(id) => setMinutes(Number(id))}
        />
      </Field>

      <p className="text-caption text-muted-foreground">
        Only <span className="font-mono">127.0.0.1</span> and <span className="font-mono">::1</span> are reachable. Ends when you stop it, leave, or close Raven.
      </p>

      {error ? <p className="text-small text-destructive" role="alert">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!valid || busy}>Share</Button>
      </div>
    </form>
  );
}
