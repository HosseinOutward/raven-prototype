import { useState } from "react";
import { Bookmark, Hand, LogIn, MessageSquare, Settings, UserCheck, UserPlus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { failureText } from "@/lib/chat/errors";
import type { ChatStore } from "@/lib/chat/store";
import { GroupedList, PresenceDot, SectionLabel } from "../atoms";
import { personStatus } from "../people";
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

  const visibleBecause = isFriend
    ? `You can see ${person.name} because you are friends.`
    : sharedTrees.length
      ? `You can see ${person.name} because you share ${namesSentence(sharedTrees.map((tree) => tree.name))}.`
      : activeNest
        ? `You can see ${person.name} because they are in ${activeNest.name}.`
        : `You and ${person.name} do not share a ${data.labels.treeSingular.toLowerCase()} yet.`;

  const knockButton = (primary: boolean) => (
    <Button
      size="lg"
      variant={primary ? "default" : "secondary"}
      className={primary ? "min-w-0 flex-1" : "shrink-0"}
      disabled={profileKnock.disabled}
      onClick={profileKnock.knock}
      aria-describedby="profile-knock-help"
    >
      <Hand className="h-4 w-4" />
      <span className="truncate">{profileKnock.label}</span>
    </Button>
  );

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
          </>
        }
      />

      {incoming && !isSelf ? (
        <div role="status" className="mt-6 flex items-center gap-3 rounded-card bg-secondary/60 px-3.5 py-3">
          <p className="min-w-0 flex-1 text-small">
            <bdi>{person.name}</bdi> asked to be your friend.
          </p>
          <Button size="sm" disabled={answering} onClick={() => actions.run("friend", () => data.acceptFriendRequest(incoming.id))}>
            Accept
          </Button>
          <Button size="sm" variant="ghost" disabled={answering} onClick={() => actions.run("friend", () => data.declineFriendRequest(incoming.id))}>
            Decline
          </Button>
        </div>
      ) : null}

      {isSelf ? (
        <div className="mt-6 flex items-center gap-2">
          <Button size="lg" variant="secondary" className="flex-1" onClick={() => onNavigate({ kind: "settings", section: "profile" })}>
            <Settings className="h-4 w-4" />
            Edit your profile
          </Button>
          {chat ? (
            <Button size="lg" variant="secondary" className="flex-1" disabled={saved.opening} onClick={saved.open}>
              <Bookmark className="h-4 w-4" />
              Saved messages
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="mt-6 flex items-center gap-2">
            {activeNest ? (
              <Button size="lg" className="min-w-0 flex-1" onClick={() => onNavigate({ kind: "nest", id: activeNest.id })}>
                <LogIn className="h-4 w-4" />
                <span className="truncate">Go to {activeNest.name}</span>
              </Button>
            ) : (
              knockButton(true)
            )}
            {activeNest ? knockButton(false) : null}
            {chat && isFriend ? (
              <Button size="lg" variant="secondary" className="shrink-0" disabled={openingChat} onClick={message}>
                <MessageSquare className="h-4 w-4" />
                Message
              </Button>
            ) : null}
          </div>
          <p id="profile-knock-help" className="mt-3 text-caption text-subtle" role="status">
            {profileKnock.description}
          </p>

          {incoming ? null : (
            <GroupedList className="mt-8">
              {isFriend ? (
                <DoorwayRow
                  icon={<UserCheck />}
                  label="Friends"
                  value={chat ? "You can message each other." : `You and ${person.name} are friends.`}
                  control={
                    <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(true)}>
                      Remove
                    </Button>
                  }
                />
              ) : outgoing ? (
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
              ) : (
                <DoorwayRow
                  icon={<UserPlus />}
                  label="Not friends yet"
                  value={chat ? "Friends can message each other." : `${person.name} decides whether to accept.`}
                  control={
                    <Button size="xs" variant="secondary" disabled={answering} onClick={() => actions.run("friend", () => data.sendFriendRequest(person.id))}>
                      Add friend
                    </Button>
                  }
                />
              )}
            </GroupedList>
          )}
        </>
      )}

      {sharedTrees.length ? (
        <section className="mt-8">
          <SectionLabel className="mb-1">{isSelf ? `${data.labels.treePlural} you’re in` : `${data.labels.treePlural} you share`}</SectionLabel>
          <GroupedList>
            {sharedTrees.map((tree) => (
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
              </button>
            ))}
          </GroupedList>
        </section>
      ) : null}

      {isSelf ? null : <p className="mt-6 text-caption text-subtle">{visibleBecause}</p>}

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
