import { useState, type ReactNode } from "react";
import { Bookmark, Hand, LogIn, MessageSquare, MoreHorizontal, Settings, UserMinus, UserPlus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { failureText } from "@/lib/chat/errors";
import type { ChatStore } from "@/lib/chat/store";
import { treeCan } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { GroupedList, LiveDot, PresenceDot, SectionLabel } from "../atoms";
import { personStatus } from "../people";
import { profileActions, type ProfileAction } from "../profile";
import { PRESENCE, type RavenShellData, type RavenView, type ShellPerson } from "../state";
import { ProfilePictureViewer } from "./ProfilePictureViewer";
import { DoorwayHeader, DoorwayPage, DoorwayRow, namesSentence } from "./shared";
import { useOpenSaved } from "../useChat";
import { useProfileKnock } from "../useProfileKnock";
import { usePendingActions } from "../usePendingActions";

/** A person's page is a way to reach them respectfully, not a profile to browse. */
export function UserPageView({
  person,
  data,
  chat = null,
  onNavigate,
}: {
  person: ShellPerson;
  data: RavenShellData;
  /** Text chat, or null when the server has none. */
  chat?: ChatStore | null;
  onNavigate: (view: RavenView) => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const profileKnock = useProfileKnock(data, person.id);
  const [openingChat, setOpeningChat] = useState(false);
  const saved = useOpenSaved(chat, onNavigate);
  // Whose picture is open: this view stays mounted when moving from one person to another.
  const [viewingPicture, setViewingPicture] = useState<string | null>(null);

  const message = () => {
    if (!chat) return;
    setOpeningChat(true);
    void chat
      .openDM(person.id)
      .then((conversation) => onNavigate({ kind: "chat", id: conversation.id }))
      .catch((failure) => toast({ title: failureText(failure, "Couldn’t open that conversation."), tone: "error" }))
      .finally(() => setOpeningChat(false));
  };
  const isSelf = person.id === data.user?.id;
  const sharedTrees = person.treeIds.map((id) => data.getTree(id)).filter((tree) => tree != null);
  const activeNest = person.activeNestIds.map((id) => data.getNest(id)).find((nest) => nest != null);
  const incoming = data.incomingFriendRequests.find((request) => request.fromUserId === person.id);
  const outgoing = data.outgoingFriendRequests.find((request) => request.toUserId === person.id);
  const isFriend = data.friends.some((friend) => friend.userId === person.id);
  // One answer at a time: accepting, declining, cancelling and asking all share the key.
  const actions = usePendingActions();
  const answering = actions.isPending("friend");
  const nestSingular = data.labels.nestSingular.toLowerCase();

  const plan = profileActions({
    isSelf,
    hasChat: Boolean(chat),
    inNest: Boolean(activeNest),
    isFriend,
    knockHeld: profileKnock.disabled,
    incoming: Boolean(incoming),
    outgoing: Boolean(outgoing),
    sharesTree: sharedTrees.length > 0,
  });
  const showsKnock = plan.primary === "knock" || plan.secondary.includes("knock");

  // Trees the viewer may add people to and this person is not in yet. Unloaded details are skipped, not guessed.
  const addableTrees = isSelf || !person.username
    ? []
    : data.trees.filter((tree) => {
        if (person.treeIds.includes(tree.id)) return false;
        const details = data.getTreeDetails(tree.id);
        return details != null && treeCan(details, "members.manage") && !details.members.some((member) => member.userId === person.id && member.state === "joined");
      });
  const addToTree = (treeId: string, treeName: string) => {
    if (!person.username) return;
    void data.addTreeMember(treeId, person.username).then(
      () => toast({ title: `Added to ${treeName}` }),
      () => undefined,
    );
  };
  const hasMenu = !isSelf && (isFriend || addableTrees.length > 0);

  const visibleBecause = isFriend
    ? `You can see ${person.name} because you are friends.`
    : sharedTrees.length
      ? `You can see ${person.name} because you share ${namesSentence(sharedTrees.map((tree) => tree.name))}.`
      : activeNest
        ? `You can see ${person.name} because they are in ${activeNest.name}.`
        : `You and ${person.name} do not share a ${data.labels.treeSingular.toLowerCase()} yet.`;

  const peopleInside = (treeId: string) =>
    data.activeNests
      .filter((nest) => nest.treeId === treeId && (nest.lifecycleState === "active" || nest.activeParticipantCount > 0))
      .reduce((sum, nest) => sum + nest.activeParticipantCount, 0);

  const button = (action: ProfileAction, primary: boolean): ReactNode => {
    const variant = primary ? "default" : action === "decline" ? "ghost" : "secondary";
    const width = primary ? "min-w-0 flex-1" : "shrink-0";
    switch (action) {
      case "editProfile":
        return (
          <Button key={action} size="lg" variant={variant} className={width} onClick={() => onNavigate({ kind: "settings", section: "profile" })}>
            <Settings className="h-4 w-4" />
            Edit your profile
          </Button>
        );
      case "saved":
        return (
          <Button key={action} size="lg" variant={variant} className={width} disabled={saved.opening} onClick={saved.open}>
            <Bookmark className="h-4 w-4" />
            Saved messages
          </Button>
        );
      case "goToNest":
        return (
          <Button key={action} size="lg" variant={variant} className={width} onClick={() => activeNest && onNavigate({ kind: "nest", id: activeNest.id })}>
            <LogIn className="h-4 w-4" />
            <span className="truncate">Go to <bdi>{activeNest?.name}</bdi></span>
          </Button>
        );
      case "knock":
        return (
          <Button key={action} size="lg" variant={variant} className={width} disabled={profileKnock.disabled} onClick={profileKnock.knock} aria-describedby="profile-knock-help">
            <Hand className="h-4 w-4" />
            <span className="truncate">{profileKnock.label}</span>
          </Button>
        );
      case "message":
        return (
          <Button key={action} size="lg" variant={variant} className={width} disabled={openingChat} onClick={message}>
            <MessageSquare className="h-4 w-4" />
            Message
          </Button>
        );
      case "addFriend":
        return (
          <Button key={action} size="lg" variant={variant} className={width} disabled={answering} onClick={() => actions.run("friend", () => data.sendFriendRequest(person.id))}>
            <UserPlus className="h-4 w-4" />
            Add friend
          </Button>
        );
      case "accept":
        return (
          <Button key={action} size="lg" variant={variant} className={width} disabled={answering} onClick={() => incoming && actions.run("friend", () => data.acceptFriendRequest(incoming.id))}>
            Accept
          </Button>
        );
      case "decline":
        return (
          <Button key={action} size="lg" variant={variant} className={width} disabled={answering} onClick={() => incoming && actions.run("friend", () => data.declineFriendRequest(incoming.id))}>
            Decline
          </Button>
        );
    }
  };

  const menu = hasMenu ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="ml-auto shrink-0" aria-label={`More for ${person.name}`}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {addableTrees.map((tree) => (
          <DropdownMenuItem key={tree.id} onSelect={() => addToTree(tree.id, tree.name)}>
            <UserPlus className="text-muted-foreground" />
            <span className="truncate">Add to <bdi>{tree.name}</bdi></span>
          </DropdownMenuItem>
        ))}
        {isFriend && addableTrees.length ? <DropdownMenuSeparator /> : null}
        {isFriend ? (
          <DropdownMenuItem onSelect={() => setConfirmRemove(true)}>
            <UserMinus className="text-muted-foreground" />
            Remove friend
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <DoorwayPage>
      <DoorwayHeader
        leading={<Avatar name={person.name} src={api.userAvatarUrl(person.id)} className="h-16 w-16 shrink-0 text-title" onOpen={() => setViewingPicture(person.id)} />}
        title={person.name}
        meta={
          <>
            {person.username ? (
              <span className="min-w-0 truncate">
                @<bdi>{person.username}</bdi>
              </span>
            ) : null}
            {person.presenceUnknown ? null : (
              <span className="inline-flex shrink-0 items-center gap-1.5">
                <PresenceDot presence={person.presence} />
                {personStatus(person, data) ?? PRESENCE[person.presence].label}
              </span>
            )}
            {isFriend && !isSelf ? <span className="shrink-0">Friends</span> : null}
          </>
        }
      />

      {incoming && !isSelf ? (
        <p role="status" className="mt-6 text-body">
          <bdi>{person.name}</bdi> asked to be your friend.
        </p>
      ) : null}

      {plan.primary || plan.secondary.length || menu ? (
        <div className={cn("flex items-center gap-2", incoming && !isSelf ? "mt-3" : "mt-6")}>
          {plan.primary ? button(plan.primary, true) : null}
          {plan.secondary.map((action) => button(action, false))}
          {menu}
        </div>
      ) : null}

      {showsKnock && profileKnock.description ? (
        <p id="profile-knock-help" role="status" className={cn("mt-3", profileKnock.disabled ? "text-small text-muted-foreground" : "text-caption text-subtle")}>
          {profileKnock.description}
        </p>
      ) : null}

      {outgoing && !isSelf ? (
        <GroupedList className="mt-6">
          <DoorwayRow
            icon={<UserPlus />}
            label="Friend request sent"
            value={`Waiting for ${person.name} to answer.`}
            control={
              <Button size="xs" variant="ghost" disabled={answering} onClick={() => actions.run("friend", () => data.cancelFriendRequest(outgoing.id))}>
                Cancel
              </Button>
            }
          />
        </GroupedList>
      ) : null}

      {sharedTrees.length ? (
        <section className="mt-8">
          <SectionLabel className="mb-1">{isSelf ? `${data.labels.treePlural} you’re in` : `${data.labels.treePlural} you share`}</SectionLabel>
          <GroupedList>
            {sharedTrees.map((tree) => {
              const inside = peopleInside(tree.id);
              return (
                <button
                  key={tree.id}
                  type="button"
                  onClick={() => onNavigate({ kind: "tree", id: tree.id })}
                  className="flex h-11 w-full items-center gap-3 px-3.5 text-left transition-colors hover:bg-secondary"
                >
                  <Avatar name={tree.name} src={api.treeAvatarUrl(tree.id, tree.updatedAt)} className="h-6 w-6 rounded-chip text-[10px]" />
                  <span className="min-w-0 flex-1 truncate text-small">
                    <bdi>{tree.name}</bdi>
                  </span>
                  {inside > 0 ? (
                    <span className="flex shrink-0 items-center gap-2 text-caption text-muted-foreground">
                      <LiveDot />
                      {inside} in a {nestSingular}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </GroupedList>
        </section>
      ) : null}

      {isSelf ? null : <p className={cn("text-small text-muted-foreground", sharedTrees.length ? "mt-2" : "mt-6")}>{visibleBecause}</p>}

      {viewingPicture === person.id ? <ProfilePictureViewer src={api.userAvatarUrl(person.id)} alt={`${person.name}’s profile picture`} onClose={() => setViewingPicture(null)} /> : null}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${person.name} as a friend?`}
        description={`You will stop seeing each other as friends. You can send a new request later.`}
        confirmLabel="Remove friend"
        destructive
        onConfirm={async () => {
          await data.removeFriend(person.id).catch(() => undefined);
          setConfirmRemove(false);
        }}
      />
    </DoorwayPage>
  );
}
