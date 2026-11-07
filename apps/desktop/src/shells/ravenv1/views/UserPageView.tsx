import { useState } from "react";
import { Bookmark, Check, ChevronDown, Hand, LogIn, MessageSquare, Settings, UserPlus, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { failureText } from "@/lib/chat/errors";
import type { ChatStore } from "@/lib/chat/store";
import { GroupedList, PresenceDot, SectionLabel } from "../atoms";
import { personStatus } from "../people";
import { PRESENCE, type RavenShellData, type RavenView, type ShellPerson } from "../state";
import { ProfilePictureViewer } from "./ProfilePictureViewer";
import { namesSentence } from "./shared";
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

  const visibleBecause = isFriend
    ? `You can see ${person.name} because you are friends.`
    : sharedTrees.length
      ? `You can see ${person.name} because you share ${namesSentence(sharedTrees.map((tree) => tree.name))}.`
      : activeNest
        ? `You can see ${person.name} because they are in ${activeNest.name}.`
        : `You and ${person.name} do not share a ${data.labels.treeSingular.toLowerCase()} yet.`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-md px-6 py-12">
        <div className="text-center">
          <Avatar name={person.name} src={api.userAvatarUrl(person.id)} className="mx-auto h-20 w-20 text-display" onOpen={() => setViewingPicture(person.id)} />
          <h1 className="mt-4 truncate text-display font-semibold">{person.name}</h1>
          {person.username ? <p className="mt-0.5 truncate text-small text-muted-foreground">@<bdi>{person.username}</bdi></p> : null}
          {person.presenceUnknown ? null : (
            <p className="mt-1 inline-flex items-center gap-2 text-small text-muted-foreground">
              <PresenceDot presence={person.presence} />
              {personStatus(person, data) ?? PRESENCE[person.presence].label}
            </p>
          )}
        </div>

        {isSelf ? (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <Button variant="secondary" onClick={() => onNavigate({ kind: "settings", section: "profile" })}>
              <Settings className="h-4 w-4" />
              Edit your profile
            </Button>
            {chat ? (
              <Button variant="secondary" disabled={saved.opening} onClick={saved.open}>
                <Bookmark className="h-4 w-4" />
                Saved messages
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {activeNest ? (
              <Button onClick={() => onNavigate({ kind: "nest", id: activeNest.id })}>
                <LogIn className="h-4 w-4" />
                Go to {activeNest.name}
              </Button>
            ) : null}
            <Button variant={activeNest ? "secondary" : "default"} disabled={profileKnock.disabled} onClick={profileKnock.knock} aria-describedby="profile-knock-help">
              <Hand className="h-4 w-4" />
              {profileKnock.label}
            </Button>
            {chat && isFriend ? (
              <Button variant="secondary" disabled={openingChat} onClick={message}>
                <MessageSquare className="h-4 w-4" />
                Message
              </Button>
            ) : null}
            {isFriend ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost">
                    <Check className="h-4 w-4" />
                    Friends
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center">
                  <DropdownMenuItem destructive onSelect={() => setConfirmRemove(true)}>Remove friend</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : incoming ? (
              <>
                <Button variant="secondary" disabled={answering} onClick={() => actions.run("friend", () => data.acceptFriendRequest(incoming.id))}>
                  <Check className="h-4 w-4" />
                  Accept friend request
                </Button>
                <Button variant="ghost" disabled={answering} onClick={() => actions.run("friend", () => data.declineFriendRequest(incoming.id))}>Decline</Button>
              </>
            ) : outgoing ? (
              <Button variant="ghost" disabled={answering} onClick={() => actions.run("friend", () => data.cancelFriendRequest(outgoing.id))}>
                <X className="h-4 w-4" />
                Cancel friend request
              </Button>
            ) : (
              <Button variant="secondary" disabled={answering} onClick={() => actions.run("friend", () => data.sendFriendRequest(person.id))}>
                <UserPlus className="h-4 w-4" />
                Add friend
              </Button>
            )}
          </div>
        )}

        {isSelf ? null : (
          <p id="profile-knock-help" className="mt-6 text-center text-small text-muted-foreground" role="status">
            {profileKnock.description}
          </p>
        )}

        {sharedTrees.length ? (
          <section className="mt-10">
            <SectionLabel className="mb-1">{isSelf ? `${data.labels.treePlural} you’re in` : `${data.labels.treePlural} you share`}</SectionLabel>
            <GroupedList>
              {sharedTrees.map((tree) => (
                <button
                  key={tree.id}
                  type="button"
                  onClick={() => onNavigate({ kind: "tree", id: tree.id })}
                  className="flex h-11 w-full items-center gap-3 px-3 text-left transition-colors hover:bg-secondary"
                >
                  <Avatar name={tree.name} src={api.treeAvatarUrl(tree.id, tree.updatedAt)} className="h-6 w-6 rounded-chip text-[10px]" />
                  <span className="min-w-0 flex-1 truncate text-small">{tree.name}</span>
                </button>
              ))}
            </GroupedList>
          </section>
        ) : null}

        {isSelf ? null : <p className="mt-6 text-center text-caption text-subtle">{visibleBecause}</p>}
      </div>

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
    </div>
  );
}
