import { useEffect, useRef, useState } from "react";
import { knockerView } from "./knockReplies";
import type { RavenShellData } from "./state";

export function useProfileKnock(data: RavenShellData, userId: string) {
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [now, setNow] = useState(Date.now);
  const state = data.home?.profileKnocks?.find((knock) => knock.userId === userId);
  const name = data.getPerson(userId)?.name ?? "They";
  useEffect(() => {
    setNow(Date.now());
    if (!state) return;
    let timer: number | undefined;
    // Count seconds near the end; an answer that holds for hours only needs the odd look.
    const schedule = () => {
      const left = Date.parse(state.retryAt) - Date.now();
      if (left <= 0) return;
      timer = window.setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, left > 120_000 ? Math.min(left, 30_000) : 1000);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [state]);
  const view = knockerView(state, name, now);
  const knock = () => {
    if (sendingRef.current || knockerView(state, name, Date.now()).disabled) return;
    sendingRef.current = true;
    setSending(true);
    void data.knockUser(userId).catch(() => undefined).finally(() => {
      sendingRef.current = false;
      setSending(false);
    });
  };
  return { ...view, disabled: sending || view.disabled, label: sending ? "Sending…" : view.label, knock };
}
