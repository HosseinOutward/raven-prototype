import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, HomeState, isUnauthorizedError, LauncherNest, NestDetails, NestLiveUpdate, PublicUser, ServerProperties, SessionSummary, TreeDetails, TreeJoinPolicy, TreeRole, TreeSearchResult, TreeVisibility } from "@/lib/api";
import type { PendingItem, RavenShellData, SelectablePresence, ShellPerson, UILabelCopy } from "./state";
import { defaultPreferences, displayNameFor, labelsForPreference, presenceFromApi } from "./state";

function messageFromError(error: unknown, fallback = "Request failed") {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useRavenShellData(): RavenShellData {
  const [home, setHome] = useState<HomeState | null>(null);
  const [serverProperties, setServerProperties] = useState<ServerProperties>(api.fallbackServerProperties());
  const [apiServerUrl, setApiServerUrl] = useState(api.getBaseUrl());
  const [apiServerHistory, setApiServerHistory] = useState(api.getServerHistory());
  const [treeDetails, setTreeDetails] = useState<Record<string, TreeDetails>>({});
  const [nestDetails, setNestDetails] = useState<Record<string, NestDetails>>({});
  const [activeSessions, setActiveSessions] = useState<Record<string, SessionSummary | null>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [serverUnreachable, setServerUnreachable] = useState(false);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const authenticated = home !== null && Boolean(api.getSessionId());

  const hydrateTrees = useCallback(async (nextHome: HomeState) => {
    const entries = await Promise.all(
      nextHome.trees.map(async (tree) => {
        try {
          return [tree.id, await api.getTree(tree.id)] as const;
        } catch {
          return null;
        }
      }),
    );
    setTreeDetails(Object.fromEntries(entries.filter(Boolean) as Array<readonly [string, TreeDetails]>));
  }, []);

  const hydrateNests = useCallback(async (nextHome: HomeState) => {
    const nestIds = new Set<string>();
    for (const nest of [...nextHome.activeNests, ...nextHome.temporaryNests]) nestIds.add(nest.id);
    for (const invite of nextHome.pendingInvites) nestIds.add(invite.nestId);
    for (const request of nextHome.pendingRequests) nestIds.add(request.nestId);
    for (const knock of nextHome.pendingKnocks) if (knock.nestId) nestIds.add(knock.nestId);

    const detailEntries = await Promise.all(
      [...nestIds].map(async (nestId) => {
        try {
          return [nestId, await api.getNest(nestId)] as const;
        } catch {
          return null;
        }
      }),
    );
    setNestDetails(Object.fromEntries(detailEntries.filter(Boolean) as Array<readonly [string, NestDetails]>));

    const sessionEntries = await Promise.all(
      [...nestIds].map(async (nestId) => {
        try {
          const result = await api.activeSession(nestId);
          return [nestId, result.session] as const;
        } catch {
          return [nestId, null] as const;
        }
      }),
    );
    setActiveSessions(Object.fromEntries(sessionEntries));
  }, []);

  const refreshServerProperties = useCallback(async () => {
    try {
      const properties = await api.serverProperties();
      setServerProperties({
        ...api.fallbackServerProperties(),
        ...properties,
        properties: properties.properties ?? {},
      });
    } catch {
      setServerProperties(api.fallbackServerProperties());
    }
    setApiServerUrl(api.getBaseUrl());
    setApiServerHistory(api.getServerHistory());
  }, []);

  const refresh = useCallback(() => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const operation = (async () => {
      setError("");
      await refreshServerProperties();
      const nextHome = await api.home();
      setHome(nextHome);
      setServerUnreachable(false);
      await Promise.all([hydrateTrees(nextHome), hydrateNests(nextHome)]);
    })();
    refreshPromiseRef.current = operation;
    const clearRefresh = () => {
      if (refreshPromiseRef.current === operation) refreshPromiseRef.current = null;
    };
    void operation.then(clearRefresh, clearRefresh);
    return operation;
  }, [hydrateNests, hydrateTrees, refreshServerProperties]);

  const refreshFriends = useCallback(async () => {
    const nextFriends = await api.friends();
    setHome((current) => current ? { ...current, ...nextFriends } : current);
  }, []);

  const refreshNestUpdates = useCallback(async (updates: NestLiveUpdate[]) => {
    const nestIds = [...new Set(updates.map((update) => update.nestId).filter((id): id is string => Boolean(id)))];
    if (nestIds.length === 0) return;

    const [homeResult, detailResults, sessionResults] = await Promise.all([
      api.home()
        .then((value) => ({ status: "fulfilled" as const, value }))
        .catch((reason: unknown) => ({ status: "rejected" as const, reason })),
      Promise.all(nestIds.map(async (nestId) => {
        try {
          return [nestId, await api.getNest(nestId)] as const;
        } catch {
          return [nestId, undefined] as const;
        }
      })),
      Promise.all(nestIds.map(async (nestId) => {
        try {
          const result = await api.activeSession(nestId);
          return [nestId, result.session] as const;
        } catch {
          return [nestId, null] as const;
        }
      })),
    ]);

    if (homeResult.status === "rejected") throw homeResult.reason;
    setHome(homeResult.value);
    setServerUnreachable(false);
    setNestDetails((current) => {
      const next = { ...current };
      detailResults.forEach(([nestId, details]) => {
        if (details) next[nestId] = details;
      });
      return next;
    });
    setActiveSessions((current) => {
      const next = { ...current };
      sessionResults.forEach(([nestId, session]) => {
        next[nestId] = session;
      });
      return next;
    });

    const treeIds = [...new Set(detailResults.flatMap(([, details]) => details?.nest.treeId ? [details.nest.treeId] : []))];
    if (treeIds.length > 0) {
      const trees = await Promise.all(treeIds.map(async (treeId) => {
        try {
          return [treeId, await api.getTree(treeId)] as const;
        } catch {
          return null;
        }
      }));
      setTreeDetails((current) => ({
        ...current,
        ...Object.fromEntries(trees.filter(Boolean) as Array<readonly [string, TreeDetails]>),
      }));
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const boot = async () => {
      await refreshServerProperties();
      if (!api.getSessionId()) {
        if (mounted) {
          setHome(null);
          setLoading(false);
        }
        return;
      }
      try {
        const nextHome = await api.home();
        if (!mounted) return;
        setHome(nextHome);
        await Promise.all([hydrateTrees(nextHome), hydrateNests(nextHome)]);
      } catch (err) {
        if (mounted) {
          setHome(null);
          if (isUnauthorizedError(err)) {
            api.clearSession();
            setError("Your session has expired. Sign in again.");
          } else {
            setServerUnreachable(true);
            setError("");
          }
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void boot();
    return () => {
      mounted = false;
    };
  }, [hydrateNests, hydrateTrees, refreshServerProperties]);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    let timer: number | null = null;
    let requestController: AbortController | null = null;

    const heartbeat = async () => {
      requestController = new AbortController();
      const controller = requestController;
      const timeout = window.setTimeout(() => controller.abort(), 8_000);
      try {
        const [presenceResult, nextFriends] = await Promise.all([
          api.presenceHeartbeat(controller.signal, false),
          api.friends(),
        ]);
        if (cancelled) return;
        setHome((current) => current ? {
          ...current,
          presence: presenceResult.presence,
          ...nextFriends,
        } : current);
      } catch {
        // A later heartbeat or the live event stream will reconcile presence.
      } finally {
        window.clearTimeout(timeout);
        if (requestController === controller) requestController = null;
        if (!cancelled) timer = window.setTimeout(() => void heartbeat(), 15_000);
      }
    };

    void heartbeat();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      requestController?.abort();
    };
  }, [authenticated, refreshFriends]);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    let timer: number | null = null;
    let running = false;
    let broadRefreshQueued = false;
    const nestUpdates = new Map<string, NestLiveUpdate>();

    const schedule = () => {
      if (cancelled || running || timer !== null) return;
      timer = window.setTimeout(() => void flush(), 150);
    };

    const flush = async () => {
      timer = null;
      if (cancelled || running) return;
      running = true;
      const runBroadRefresh = broadRefreshQueued;
      broadRefreshQueued = false;
      const updates = [...nestUpdates.values()];
      nestUpdates.clear();
      try {
        if (runBroadRefresh) await refresh();
        else await refreshNestUpdates(updates);
      } catch (err) {
        if (!cancelled) setError(messageFromError(err));
      } finally {
        running = false;
        if (broadRefreshQueued || nestUpdates.size > 0) schedule();
      }
    };

    const onUpdate = (update: NestLiveUpdate) => {
      if (update.nestId) nestUpdates.set(update.nestId, update);
      else broadRefreshQueued = true;
      schedule();
    };
    const unsubscribe = api.subscribeNestEvents(onUpdate);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [authenticated, refresh, refreshNestUpdates]);

  const login = useCallback(
    async (username: string, password: string) => {
      setBusy(true);
      setError("");
      try {
        await api.login(username, password);
        await refresh();
      } catch (err) {
        setError(messageFromError(err, "Login failed"));
      } finally {
        setBusy(false);
        setLoading(false);
      }
    },
    [refresh],
  );

  const logout = useCallback(() => {
    void api.logout().catch(() => undefined);
    api.clearSession();
    setServerUnreachable(false);
    setHome(null);
    setTreeDetails({});
    setNestDetails({});
    setActiveSessions({});
  }, []);

  const retryConnection = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await refresh();
      setServerUnreachable(false);
    } catch (err) {
      if (isUnauthorizedError(err)) {
        api.clearSession();
        setServerUnreachable(false);
        setError("Your session has expired. Sign in again.");
      } else {
        setServerUnreachable(true);
      }
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const selectApiServer = useCallback(
    async (url: string) => {
      setBusy(true);
      setError("");
      try {
        api.clearSession();
        api.setBaseUrl(url, true);
        setHome(null);
        setTreeDetails({});
        setNestDetails({});
        setActiveSessions({});
        await refreshServerProperties();
      } catch (err) {
        setError(messageFromError(err, "Server could not be selected"));
        throw err;
      } finally {
        setBusy(false);
        setLoading(false);
      }
    },
    [refreshServerProperties],
  );

  const joinNest = useCallback(
    async (nestId: string) => {
      setBusy(true);
      setError("");
      try {
        const result = await api.joinNest(nestId);
        await refresh();
        return result.status;
      } catch (err) {
        setError(messageFromError(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const knockUser = useCallback(
    async (userId: string) => {
      setBusy(true);
      setError("");
      try {
        await api.createKnock({ toUserId: userId });
        await refresh();
      } catch (err) {
        setError(messageFromError(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const dismissKnock = useCallback(
    async (knockId: string) => {
      setBusy(true);
      setError("");
      try {
        await api.dismissKnock(knockId);
        await refresh();
      } catch (err) {
        setError(messageFromError(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const activeNests = home?.activeNests ?? [];
  const temporaryNests = home?.temporaryNests ?? [];
  const trees = home?.trees ?? [];
  const friends = home?.friends ?? [];
  const incomingFriendRequests = home?.incomingFriendRequests ?? [];
  const outgoingFriendRequests = home?.outgoingFriendRequests ?? [];
  const preferences = home?.user.preferences ?? defaultPreferences(home?.user.username);
  const labels = useMemo(() => labelsForPreference(preferences.uiLabels), [preferences.uiLabels]);

  const people = useMemo(() => derivePeople(home, treeDetails), [home, treeDetails]);
  const pending = useMemo(() => derivePending(home, nestDetails, labels), [home, labels, nestDetails]);

  const getTree = useCallback((id: string) => trees.find((tree) => tree.id === id) ?? treeDetails[id]?.tree, [treeDetails, trees]);
  const getTreeDetails = useCallback((id: string) => treeDetails[id], [treeDetails]);
  const getNestDetails = useCallback((id: string) => nestDetails[id], [nestDetails]);
  const getActiveSession = useCallback((id: string) => activeSessions[id], [activeSessions]);
  const getPerson = useCallback((id: string) => people.find((person) => person.id === id), [people]);
  const getNest = useCallback(
    (id: string) =>
      nestDetails[id]?.nest ??
      activeNests.find((nest) => nest.id === id) ??
      temporaryNests.find((nest) => nest.id === id) ??
      Object.values(treeDetails)
        .flatMap((details) => [...details.activeNests, ...details.inactiveNests])
        .find((nest) => nest.id === id),
    [activeNests, nestDetails, temporaryNests, treeDetails],
  );

  const runMutation = useCallback(
    async <T,>(action: () => Promise<T>) => {
      setBusy(true);
      setError("");
      try {
        const result = await action();
        await refresh();
        return result;
      } catch (err) {
        setError(messageFromError(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const searchUsers = useCallback(async (query: string): Promise<PublicUser[]> => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    const result = await api.searchUsers(trimmed);
    return result.users;
  }, []);

  const searchTrees = useCallback(async (query: string): Promise<TreeSearchResult[]> => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    const result = await api.searchTrees(trimmed);
    return result.trees;
  }, []);

  const createTree = useCallback((name: string) => runMutation(() => api.createTree({ name }).then((result) => result.tree)), [runMutation]);
  const updateTreeSettings = useCallback(
    (treeId: string, settings: { name: string; description: string; joinPolicy: TreeJoinPolicy; visibility: TreeVisibility }) =>
      runMutation(() => api.updateTreeSettings(treeId, settings).then((result) => result.tree)),
    [runMutation],
  );
  const deleteTree = useCallback((treeId: string, confirmation: string) => runMutation(() => api.deleteTree(treeId, confirmation)), [runMutation]);
  const joinTree = useCallback(
    (treeId: string) =>
      runMutation(async () => {
        const result = await api.joinTree(treeId);
        return result.status;
      }),
    [runMutation],
  );
  const createTreeNest = useCallback(
    (treeId: string, name: string) => runMutation(() => api.createTreeNest(treeId, name).then((result) => result.nest)),
    [runMutation],
  );
  const addTreeMember = useCallback(
    (treeId: string, username: string, role: TreeRole = "member") =>
      runMutation(() => api.addTreeMember(treeId, username, role).then((result) => result.member)),
    [runMutation],
  );
  const updateTreeMemberRole = useCallback(
    (treeId: string, userId: string, role: TreeRole) =>
      runMutation(() => api.updateTreeMemberRole(treeId, userId, role).then((result) => result.member)),
    [runMutation],
  );
  const removeTreeMember = useCallback((treeId: string, userId: string) => runMutation(() => api.removeTreeMember(treeId, userId)), [runMutation]);
  const acceptTreeJoinRequest = useCallback((treeId: string, requestId: string) => runMutation(() => api.acceptTreeJoinRequest(treeId, requestId).then(() => undefined)), [runMutation]);
  const rejectTreeJoinRequest = useCallback((treeId: string, requestId: string) => runMutation(() => api.rejectTreeJoinRequest(treeId, requestId).then(() => undefined)), [runMutation]);
  const sendFriendRequest = useCallback((userId: string) => runMutation(() => api.createFriendRequest({ toUserId: userId }).then(() => undefined)), [runMutation]);
  const acceptFriendRequest = useCallback((requestId: string) => runMutation(() => api.acceptFriendRequest(requestId).then(() => undefined)), [runMutation]);
  const declineFriendRequest = useCallback((requestId: string) => runMutation(() => api.declineFriendRequest(requestId).then(() => undefined)), [runMutation]);
  const cancelFriendRequest = useCallback((requestId: string) => runMutation(() => api.cancelFriendRequest(requestId).then(() => undefined)), [runMutation]);
  const removeFriend = useCallback((userId: string) => runMutation(() => api.removeFriend(userId)), [runMutation]);
  const setPresence = useCallback(
    (presence: SelectablePresence) =>
      runMutation(async () => {
        const activeNestId = home?.presence.activeNestId ?? null;
        switch (presence) {
          case "open":
          case "around":
          case "focused":
            await api.updatePresence(activeNestId ? "in_nest" : "available", presence, activeNestId);
            return;
          case "dnd":
            await api.updatePresence("dnd", "unavailable", activeNestId);
            return;
          case "invisible":
            await api.updatePresence("invisible", "unavailable", null);
            return;
        }
      }),
    [home?.presence.activeNestId, runMutation],
  );
  const updatePreferences = useCallback(
    (patch: Parameters<typeof api.updatePreferences>[0]) =>
      runMutation(async () => {
        await api.updatePreferences(patch);
      }),
    [runMutation],
  );

  return {
    user: home?.user ?? null,
    preferences,
    labels,
    serverProperties,
    apiServerUrl,
    apiServerHistory,
    home,
    presence: home?.presence ?? null,
    trees,
    treeDetails,
    nestDetails,
    activeSessions,
    activeNests,
    temporaryNests,
    friends,
    incomingFriendRequests,
    outgoingFriendRequests,
    people,
    pending,
    loading,
    busy,
    error,
    serverUnreachable,
    login,
    logout,
    selectApiServer,
    refresh,
    retryConnection,
    updatePreferences,
    getTree,
    getNest,
    getPerson,
    getTreeDetails,
    getNestDetails,
    getActiveSession,
    searchUsers,
    searchTrees,
    createTree,
    updateTreeSettings,
    deleteTree,
    joinTree,
    createTreeNest,
    addTreeMember,
    updateTreeMemberRole,
    removeTreeMember,
    acceptTreeJoinRequest,
    rejectTreeJoinRequest,
    sendFriendRequest,
    acceptFriendRequest,
    declineFriendRequest,
    cancelFriendRequest,
    removeFriend,
    setPresence,
    joinNest,
    knockUser,
    dismissKnock,
  };
}

export function derivePeople(home: HomeState | null, treeDetails: Record<string, TreeDetails>): ShellPerson[] {
  if (!home) return [];
  const people = new Map<string, ShellPerson>();

  const ensure = (userId: string, name: string): ShellPerson => {
    const current = people.get(userId);
    if (current) return current;
    const next: ShellPerson = { id: userId, name, presence: "offline", treeIds: [], activeNestIds: [], relationship: "context" };
    people.set(userId, next);
    return next;
  };

  for (const friend of home.friends) {
    const person = ensure(friend.userId, displayNameFor(friend));
    person.relationship = "friend";
    person.presence = presenceFromApi({ state: friend.presenceState, reachability: friend.reachability });
    if (friend.activeNestId && !person.activeNestIds.includes(friend.activeNestId)) person.activeNestIds.push(friend.activeNestId);
  }

  for (const details of Object.values(treeDetails)) {
    for (const member of details.members) {
      if (member.userId === home.user.id) continue;
      const person = ensure(member.userId, displayNameFor(member));
      if (person.relationship !== "friend") {
        person.presence = presenceFromApi({ state: member.presenceState, reachability: member.reachability });
      }
      if (!person.treeIds.includes(details.tree.id)) person.treeIds.push(details.tree.id);
    }
  }

  for (const nest of home.activeNests) {
    for (const participant of nest.currentParticipants) {
      if (participant.userId === home.user.id) continue;
      const person = ensure(participant.userId, displayNameFor(participant));
      if (person.relationship !== "friend" && person.presence === "offline") person.presence = "open";
      if (!person.activeNestIds.includes(nest.id)) person.activeNestIds.push(nest.id);
    }
  }

  for (const knock of home.pendingKnocks) {
    if (knock.fromUserId === home.user.id) continue;
    const person = ensure(knock.fromUserId, knock.fromDisplayName || knock.fromUsername);
    if (person.relationship !== "friend" && person.presence === "offline") person.presence = "open";
  }

  for (const request of [...home.incomingFriendRequests, ...home.outgoingFriendRequests]) {
    const userId = request.fromUserId === home.user.id ? request.toUserId : request.fromUserId;
    const name = request.fromUserId === home.user.id ? request.toDisplayName || request.toUsername : request.fromDisplayName || request.fromUsername;
    ensure(userId, name);
  }

  return [...people.values()].sort((a, b) => {
    if (a.relationship !== b.relationship) return a.relationship === "friend" ? -1 : 1;
    const presenceDelta = presenceSortRank(a.presence) - presenceSortRank(b.presence);
    if (presenceDelta) return presenceDelta;
    const activeDelta = b.activeNestIds.length - a.activeNestIds.length;
    return activeDelta || a.name.localeCompare(b.name);
  });
}

export function presenceSortRank(presence: ShellPerson["presence"]) {
  return { open: 0, around: 1, focused: 2, dnd: 3, invisible: 4, offline: 5 }[presence];
}

function derivePending(home: HomeState | null, nestDetails: Record<string, NestDetails>, labels: UILabelCopy): PendingItem[] {
  if (!home) return [];
  const items: PendingItem[] = [];
  for (const knock of home.pendingKnocks) {
    items.push({
      id: knock.id,
      kind: "knock",
      from: knock.fromDisplayName || knock.fromUsername,
      fromId: knock.fromUserId,
      context: knock.nestName ? `knocked on ${knock.nestName}` : "wants to reach you",
      knock,
    });
  }
  for (const invite of home.pendingInvites) {
    const nest = nestDetails[invite.nestId]?.nest;
    items.push({
      id: invite.id,
      kind: "invite",
      from: displayNameFor(invite),
      nestId: invite.nestId,
      context: nest ? `invited to ${nest.name}` : `invited you to a ${labels.nestSingular}`,
    });
  }
  for (const request of home.pendingRequests) {
    items.push({
      id: request.id,
      kind: "request",
      from: displayNameFor(request),
      fromId: request.userId,
      nestId: request.nestId,
      context: `requested ${request.nestName}`,
      request,
    });
  }
  for (const request of home.incomingFriendRequests) {
    items.push({
      id: request.id,
      kind: "friend",
      from: request.fromDisplayName || request.fromUsername,
      fromId: request.fromUserId,
      context: "sent a friend request",
      request,
    });
  }
  return items;
}
