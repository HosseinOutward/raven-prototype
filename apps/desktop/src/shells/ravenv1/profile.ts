export type ProfileAction = "editProfile" | "saved" | "goToNest" | "knock" | "message" | "addFriend" | "accept" | "decline";

export interface ProfileActionsInput {
  isSelf: boolean;
  hasChat: boolean;
  /** They are in a nest the viewer can see. */
  inNest: boolean;
  isFriend: boolean;
  /** A knock is waiting on their answer or held back by it, so Knock is disabled. */
  knockHeld: boolean;
  incoming: boolean;
  outgoing: boolean;
  sharesTree: boolean;
}

/**
 * The buttons on a person's page: at most one primary, chosen by the relationship.
 * A friend request waiting on you comes first, because it has to be answered before anything else.
 */
export function profileActions(input: ProfileActionsInput): { primary: ProfileAction | null; secondary: ProfileAction[] } {
  const { isSelf, hasChat, inNest, isFriend, knockHeld, incoming, outgoing, sharesTree } = input;
  if (isSelf) return { primary: "editProfile", secondary: hasChat ? ["saved"] : [] };
  if (incoming) return { primary: "accept", secondary: ["decline"] };
  if (inNest) return { primary: "goToNest", secondary: isFriend && hasChat ? ["knock", "message"] : ["knock"] };
  if (outgoing) return { primary: null, secondary: [] };
  if (isFriend) {
    if (knockHeld && hasChat) return { primary: "message", secondary: ["knock"] };
    return { primary: "knock", secondary: hasChat ? ["message"] : [] };
  }
  return { primary: "addFriend", secondary: sharesTree ? ["knock"] : [] };
}
