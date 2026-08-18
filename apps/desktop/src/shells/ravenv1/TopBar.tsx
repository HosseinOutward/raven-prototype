import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Avatar } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Bell, Check, ChevronDown, ChevronLeft, ChevronRight, Globe2, Home, RefreshCw, Search, UserMinus, UserPlus, X } from "lucide-react";
import type { RavenShellData, RavenView } from "./state";
import { displayNameFor } from "./state";
import type { PublicUser, TreeSearchResult } from "@/lib/api";

export function TopBar({
  view,
  data,
  onNavigate,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
}: {
  view: RavenView;
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  const selfName = data.user ? displayNameFor(data.user) : "You";
  return (
    <header
      className="raven-window-drag flex h-12 shrink-0 items-center gap-2 bg-background pl-3 text-foreground"
      onMouseDown={handleCaptionMouseDown}
    >
      <div className="flex shrink-0 items-center gap-1.5">
        <NavButton label="Back" disabled={!canGoBack} onClick={onBack}>
          <ChevronLeft className="h-[18px] w-[18px]" />
        </NavButton>
        <NavButton label="Forward" disabled={!canGoForward} onClick={onForward}>
          <ChevronRight className="h-[18px] w-[18px]" />
        </NavButton>
      </div>

      <NavButton label="Home" active={view.kind === "home"} onClick={() => onNavigate({ kind: "home" })}>
        <Home className="h-[18px] w-[18px]" />
      </NavButton>

      <GlobalSearch data={data} onNavigate={onNavigate} />

      <div className="ml-auto flex shrink-0 items-center gap-1.5 pr-2">
        <button
          type="button"
          aria-label="Refresh Raven state"
          onClick={() => void data.refresh()}
          className="raven-no-drag flex h-9 w-9 items-center justify-center rounded-full bg-card/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn("h-[18px] w-[18px]", data.busy && "animate-spin")} />
        </button>
        <button
          type="button"
          aria-label="Invites, knocks and requests"
          className="raven-no-drag relative flex h-9 w-9 items-center justify-center rounded-full bg-card/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Bell className="h-[18px] w-[18px]" />
          {data.pending.length > 0 ? (
            <span className="absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full bg-amber-400/90 ring-2 ring-background" />
          ) : null}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="User menu"
              className={cn(
                "raven-no-drag flex h-9 items-center gap-2 rounded-full py-1 pl-1 pr-2.5 transition-colors",
                view.kind === "settings" ? "bg-accent" : "bg-card/80 hover:bg-accent",
              )}
            >
              <Avatar name={selfName} src={data.user ? `${data.apiServerUrl}/v1/media/users/${data.user.id}/avatar?v=${encodeURIComponent(data.user.updatedAt)}` : undefined} className="h-7 w-7 text-[10px]" />
              <span className="hidden max-w-[116px] truncate text-xs font-medium lg:block">{selfName}</span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="raven-no-drag min-w-[9rem]">
            <DropdownMenuItem onSelect={() => onNavigate({ kind: "settings" })}>Settings</DropdownMenuItem>
            <DropdownMenuItem onSelect={data.logout}>Log out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <WindowCaptionControls />
    </header>
  );
}

export function BareTopBar({ title = "Raven" }: { title?: string }) {
  return (
    <header
      className="raven-window-drag flex h-12 shrink-0 items-center bg-background pl-3 text-foreground"
      onMouseDown={handleCaptionMouseDown}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
          R
        </div>
        <div className="min-w-0 truncate text-sm font-semibold tracking-tight">{title}</div>
      </div>
      <div className="min-w-0 flex-1" />
      <WindowCaptionControls />
    </header>
  );
}

function WindowCaptionControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = currentTauriWindow();
    if (!appWindow) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const refresh = () => {
      void appWindow
        .isMaximized()
        .then((nextMaximized) => {
          if (active) setMaximized(nextMaximized);
        })
        .catch(() => undefined);
    };

    refresh();
    appWindow
      .onResized(refresh)
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const minimize = () => {
    void currentTauriWindow()?.minimize();
  };
  const toggleMaximize = () => {
    const appWindow = currentTauriWindow();
    if (!appWindow) return;
    void appWindow
      .toggleMaximize()
      .then(() => appWindow.isMaximized())
      .then(setMaximized)
      .catch(() => undefined);
  };
  const close = () => {
    void currentTauriWindow()?.close();
  };

  return (
    <div className="raven-no-drag flex h-12 shrink-0 items-stretch" aria-label="Window controls">
      <CaptionButton label="Minimize" glyph={0xe921} onClick={minimize} />
      <CaptionButton label={maximized ? "Restore" : "Maximize"} glyph={maximized ? 0xe923 : 0xe922} onClick={toggleMaximize} />
      <CaptionButton label="Close" glyph={0xe8bb} danger onClick={close} />
    </div>
  );
}

function CaptionButton({
  label,
  glyph,
  danger,
  onClick,
}: {
  label: string;
  glyph: number;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-12 w-[46px] cursor-default items-center justify-center text-[10px] text-muted-foreground transition-colors",
        danger ? "hover:bg-[#c42b1c] hover:text-white" : "hover:bg-white/10 hover:text-foreground",
      )}
    >
      <span
        aria-hidden
        className="leading-none"
        style={{ fontFamily: "\"Segoe Fluent Icons\", \"Segoe MDL2 Assets\", \"Segoe UI Symbol\", sans-serif" }}
      >
        {String.fromCharCode(glyph)}
      </span>
    </button>
  );
}

function handleCaptionMouseDown(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0) return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || isInteractiveCaptionTarget(target)) return;
  const appWindow = currentTauriWindow();
  if (!appWindow) return;
  if (event.detail >= 2) {
    event.preventDefault();
    void appWindow.toggleMaximize();
    return;
  }
  void appWindow.startDragging();
}

function currentTauriWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

function isInteractiveCaptionTarget(target: HTMLElement) {
  return Boolean(
    target.closest(
      [
        "button",
        "input",
        "textarea",
        "select",
        "a",
        "[role='button']",
        "[role='menu']",
        "[role='menuitem']",
        "[data-radix-popper-content-wrapper]",
        ".raven-no-drag",
      ].join(","),
    ),
  );
}

function GlobalSearch({ data, onNavigate }: { data: RavenShellData; onNavigate: (view: RavenView) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [trees, setTrees] = useState<TreeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const label = `Search users or ${data.labels.treePlural.toLowerCase()}`;

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setUsers([]);
      setTrees([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      Promise.all([data.searchUsers(query), data.searchTrees(query)])
        .then(([nextUsers, nextTrees]) => {
          if (!cancelled) {
            setUsers(nextUsers);
            setTrees(nextTrees);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setUsers([]);
            setTrees([]);
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [data, open, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isSearchShortcutBlocked(event.target)) return;
      event.preventDefault();
      setOpen(true);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openUser = (user: PublicUser) => {
    onNavigate({
      kind: "user",
      id: user.id,
      person: {
        id: user.id,
        name: displayNameFor(user),
        presence: "around",
        treeIds: [],
        activeNestIds: [],
        relationship: user.relationship === "friends" ? "friend" : "context",
      },
    });
    setOpen(false);
  };

  const openTree = (result: TreeSearchResult) => {
    onNavigate(
      result.accessState === "joined" && data.getTreeDetails(result.tree.id)
        ? { kind: "tree", id: result.tree.id }
        : { kind: "tree-preview", result },
    );
    setOpen(false);
  };

  const hasResults = users.length > 0 || trees.length > 0;

  return (
    <div className="raven-no-drag relative ml-1 min-w-[180px] max-w-xl flex-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-full min-w-0 items-center gap-2.5 rounded-full bg-card/80 px-4 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="truncate">{label}</span>
        <kbd className="rv-mono ml-auto hidden shrink-0 rounded bg-background/55 px-1.5 py-0.5 text-[10px] text-muted-foreground/80 sm:block">
          /
        </kbd>
      </button>

      {open ? (
        <div className="raven-no-drag absolute left-0 top-11 z-50 w-full rounded-2xl bg-card p-2 shadow-2xl shadow-black/35">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-background/50 px-3">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              autoFocus
              placeholder={label}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="rv-mono rounded bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground">/</kbd>
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)} aria-label="Close search">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-2 max-h-[320px] overflow-y-auto">
            {query.trim().length < 2 ? (
              <div className="px-3 py-4 rv-mono text-[11px] text-muted-foreground">Type at least 2 characters.</div>
            ) : searching ? (
              <div className="px-3 py-4 rv-mono text-[11px] text-muted-foreground">Searching...</div>
            ) : hasResults ? (
              <>
                {users.length ? (
                  <SearchGroup label="Users">
                    {users.map((user) => (
                      <SearchResult key={user.id} user={user} data={data} onOpenUser={() => openUser(user)} />
                    ))}
                  </SearchGroup>
                ) : null}
                {trees.length ? (
                  <SearchGroup label={`Public ${data.labels.treePlural}`}>
                    {trees.map((result) => (
                      <TreeSearchResultRow key={result.tree.id} result={result} data={data} onOpenTree={() => openTree(result)} />
                    ))}
                  </SearchGroup>
                ) : null}
              </>
            ) : (
              <div className="px-3 py-4 rv-mono text-[11px] text-muted-foreground">No matching users or {data.labels.treePlural.toLowerCase()}.</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SearchGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="py-1">
      <div className="px-2 pb-1 rv-mono text-[10px] uppercase text-muted-foreground/70">{label}</div>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function SearchResult({ user, data, onOpenUser }: { user: PublicUser; data: RavenShellData; onOpenUser: () => void }) {
  const name = displayNameFor(user);
  return (
    <div className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-accent/40">
      <button type="button" onClick={onOpenUser} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <Avatar name={name} src={`${data.apiServerUrl}/v1/media/users/${user.id}/avatar`} className="h-8 w-8 text-[10px]" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="rv-mono text-[10px] text-muted-foreground">@{user.username} · {relationshipLabel(user.relationship)}</div>
        </div>
      </button>
      <SearchAction user={user} data={data} />
    </div>
  );
}

function TreeSearchResultRow({
  result,
  data,
  onOpenTree,
}: {
  result: TreeSearchResult;
  data: RavenShellData;
  onOpenTree: () => void;
}) {
  const policy = result.tree.joinPolicy === "free" ? "Free join" : "Request required";
  const state = result.accessState === "joined" ? "Joined" : result.accessState === "pending" ? "Request sent" : "Public";
  return (
    <button type="button" onClick={onOpenTree} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-accent/40">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/70 text-muted-foreground">
        <Globe2 className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{result.tree.name}</span>
          <span className="rv-mono rounded bg-secondary/50 px-1.5 py-0.5 text-[9px] text-muted-foreground">{data.labels.treeSingular}</span>
        </span>
        <span className="block truncate rv-mono text-[10px] text-muted-foreground">
          {state} - {policy}{result.tree.description ? ` - ${result.tree.description}` : ""}
        </span>
      </span>
    </button>
  );
}

function SearchAction({ user, data }: { user: PublicUser; data: RavenShellData }) {
  if (user.relationship === "self") return <span className="rv-mono text-[10px] text-muted-foreground">you</span>;
  if (user.relationship === "friends") {
    return (
      <IconAction label="Remove friend" onClick={() => void data.removeFriend(user.id)}>
        <UserMinus className="h-4 w-4" />
      </IconAction>
    );
  }
  if (user.relationship === "incoming_pending" && user.friendRequestId) {
    return (
      <div className="flex gap-1">
        <IconAction label="Accept request" onClick={() => void data.acceptFriendRequest(user.friendRequestId!)}>
          <Check className="h-4 w-4" />
        </IconAction>
        <IconAction label="Decline request" onClick={() => void data.declineFriendRequest(user.friendRequestId!)}>
          <X className="h-4 w-4" />
        </IconAction>
      </div>
    );
  }
  if (user.relationship === "outgoing_pending" && user.friendRequestId) {
    return (
      <IconAction label="Cancel request" onClick={() => void data.cancelFriendRequest(user.friendRequestId!)}>
        <X className="h-4 w-4" />
      </IconAction>
    );
  }
  return (
    <IconAction label="Send friend request" onClick={() => void data.sendFriendRequest(user.id)}>
      <UserPlus className="h-4 w-4" />
    </IconAction>
  );
}

function IconAction({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background/50 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function relationshipLabel(relationship: PublicUser["relationship"]) {
  if (relationship === "self") return "you";
  if (relationship === "friends") return "friend";
  if (relationship === "incoming_pending") return "sent you a request";
  if (relationship === "outgoing_pending") return "request sent";
  return "not connected";
}

function isSearchShortcutBlocked(target: EventTarget | null) {
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return true;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
}

function NavButton({
  children,
  label,
  active,
  disabled,
  onClick,
}: {
  children: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "raven-no-drag flex h-9 w-9 items-center justify-center rounded-full transition-colors",
        active ? "bg-card text-foreground" : "bg-card/80 text-muted-foreground hover:bg-accent hover:text-foreground",
        disabled && "cursor-default opacity-40 hover:bg-card/80 hover:text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}
