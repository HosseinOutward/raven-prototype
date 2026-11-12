import React, { useCallback, useEffect, useState, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@/styles.css";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/toast";
import { accountsOffered } from "@/lib/invites";
import { installTheme } from "@/lib/theme";
import { ChoosePassword, ShellLogin } from "@/shells/ravenv1/SignIn";
import { useChat } from "@/shells/ravenv1/useChat";
import { useRavenShellData } from "@/shells/ravenv1/useRavenShellData";
import { CallScreen } from "./Call";
import { ChatScreen } from "./Chat";
import { HomeScreen, TreeScreen } from "./Lists";

export type Screen = { kind: "home" } | { kind: "tree"; id: string } | { kind: "chat"; id: string } | { kind: "call"; nestId: string };

const HOME: Screen = { kind: "home" };

function App() {
  const data = useRavenShellData();
  const chat = useChat(data);
  const [screen, setScreen] = useState<Screen>(HOME);

  // Each screen is a history entry, so Android's back button (Capacitor's App plugin
  // goes back in the WebView) returns to the one before.
  useEffect(() => {
    const onPop = (event: PopStateEvent) => setScreen((event.state as Screen | null) ?? HOME);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const open = useCallback((next: Screen) => {
    window.history.pushState(next, "");
    setScreen(next);
  }, []);
  const back = useCallback(() => window.history.back(), []);

  const signedInId = data.user?.id;
  useEffect(() => {
    window.history.replaceState(HOME, "");
    setScreen(HOME);
  }, [signedInId]);

  if (data.loading) {
    return (
      <Frame>
        <div className="flex flex-1 items-center justify-center gap-2.5 text-small text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          Opening Raven…
        </div>
      </Frame>
    );
  }
  if (!data.user) {
    return (
      <Frame>
        {data.passwordChangeRequired ? (
          <ChoosePassword onChange={data.changePassword} onLogout={data.logout} />
        ) : (
          <ShellLogin
            busy={data.busy}
            error={data.error}
            notice={data.notice}
            serverName={data.serverProperties.name}
            serverDescription={data.serverProperties.description}
            serverAvatar={data.serverProperties.avatar}
            apiServerUrl={data.apiServerUrl}
            apiServerHistory={data.apiServerHistory}
            onServerSelect={data.selectApiServer}
            accounts={accountsOffered(data.serverProperties)}
            onLogin={data.login}
            savedAccounts={data.savedAccounts}
            onSwitchAccount={data.switchAccount}
            onSignUp={data.signUp}
          />
        )}
      </Frame>
    );
  }
  return (
    <Frame>
      {screen.kind === "home" ? (
        <HomeScreen data={data} chat={chat} onOpen={open} />
      ) : screen.kind === "tree" ? (
        <TreeScreen treeId={screen.id} data={data} chat={chat} onOpen={open} onBack={back} />
      ) : screen.kind === "chat" && chat ? (
        <ChatScreen conversationId={screen.id} data={data} chat={chat} onBack={back} />
      ) : screen.kind === "call" ? (
        <CallScreen nestId={screen.nestId} data={data} onBack={back} />
      ) : null}
      <Toaster />
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="ravenv1-scope flex h-dvh flex-col overflow-hidden bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-foreground">{children}</div>;
}

installTheme();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
