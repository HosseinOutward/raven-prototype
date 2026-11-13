import { useCallback, useEffect, useMemo, useState } from "react";
import type { RavenView } from "@/shells/ravenv1/state";

const HOME: RavenView = { kind: "home" };

function viewKey(view: RavenView) {
  switch (view.kind) {
    case "home":
    case "settings":
    case "mixer":
    case "messages":
    case "licences":
      return view.kind;
    case "tree-preview":
      return `${view.kind}:${view.result.tree.id}`;
    default:
      return `${view.kind}:${view.id}`;
  }
}

/** Opens `next` on top of the stack. Another section of the same place (a settings
 * category) replaces the top instead, so Back leaves the place in one step. */
export function pushView(stack: RavenView[], next: RavenView): RavenView[] {
  const top = stack[stack.length - 1];
  if (top && viewKey(top) === viewKey(next)) return [...stack.slice(0, -1), next];
  return [...stack, next];
}

/** A Back stack for system Back; it starts over at Home for each signed-in user. */
export function useMobileNativeNavigation(userId: string | undefined) {
  const [stack, setStack] = useState<RavenView[]>([HOME]);
  useEffect(() => setStack([HOME]), [userId]);
  const navigate = useCallback((next: RavenView) => setStack((current) => pushView(current, next)), []);
  const goBack = useCallback(() => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current)), []);
  const leaveView = useCallback(() => setStack((current) => (current.length > 1 ? current.slice(0, -1) : [HOME])), []);
  const canGoBack = stack.length > 1;
  const navigation = useMemo(() => ({ canGoBack, goBack, navigate, leaveView }), [canGoBack, goBack, navigate, leaveView]);
  return { view: stack[stack.length - 1] ?? HOME, navigation };
}
