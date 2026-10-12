import { useEffect, useRef, useState } from "react";
import { profileKnockPresentation } from "./profileKnock";
import type { RavenShellData } from "./state";

export function useProfileKnock(data: RavenShellData, userId: string) {
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [now, setNow] = useState(Date.now);
  const state = data.home?.profileKnocks?.find((knock) => knock.userId === userId);
  useEffect(() => {
    setNow(Date.now());
    if (!state) return;
    if (Date.now() >= Date.parse(state.retryAt)) return;
    const timer = window.setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= Date.parse(state.retryAt)) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state]);
  const presentation = profileKnockPresentation(state, now);
  const knock = () => {
    if (sendingRef.current || profileKnockPresentation(state, Date.now()).disabled) return;
    sendingRef.current = true;
    setSending(true);
    void data.knockUser(userId).catch(() => undefined).finally(() => {
      sendingRef.current = false;
      setSending(false);
    });
  };
  return { ...presentation, disabled: sending || presentation.disabled, label: sending ? "Sending…" : presentation.label, knock };
}
