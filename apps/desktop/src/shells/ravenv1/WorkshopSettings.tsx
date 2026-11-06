import { setPortSharingEnabled, usePortSharingEnabled, useWorkshopConfig } from "@/lib/workshop";
import { capabilitiesOf } from "@/lib/permissions";
import { routeNotes, type WorkshopConfig } from "@/lib/workshopState";
import { SettingsHint, SettingsPage, SettingsRows, SettingsSection, SettingsToggleRow } from "./SettingsScaffold";
import type { RavenShellData } from "./state";

/**
 * The Workshop: power-user features, each off until chosen. Under each switch, on or off,
 * the facts: what it does, the protocol, the encryption, the route and who can read it.
 */
export function WorkshopSettings({ data }: { data: RavenShellData }) {
  const on = usePortSharingEnabled();
  const config = useWorkshopConfig(on);
  const capabilities = capabilitiesOf(data.user);
  const blocked = capabilities.sharePorts === false && capabilities.usePorts === false;
  return (
    <SettingsPage title="Workshop" description="Power tools for tinkerers. Everything here is off until you turn it on.">
      <SettingsSection title="Port sharing">
        <SettingsRows>
          <SettingsToggleRow
            label="Port sharing"
            description="Share a local TCP or UDP port, like a game server or a shell, with people in the same call or room. Adds Ports to the call and room header."
            checked={on}
            disabled={blocked}
            onChange={setPortSharingEnabled}
          />
          <Fact label="Route">Your computer → relay on this server → their computer. Never direct.</Fact>
          <Fact label="Transport">QUIC with TLS 1.3. Fallback: WebSocket with TLS, usually on 443.</Fact>
          {on && config ? <DeclaredNotes config={config} /> : null}
          <Fact label="End to end">
            <span className="text-warning">Not yet.</span> The relay and any CDN that ends TLS can read forwarded traffic.
          </Fact>
          <Fact label="Reachable">
            Only <Mono>127.0.0.1</Mono> and <Mono>::1</Mono> on your side. Others get it on their <Mono>127.0.0.1</Mono>.
          </Fact>
          <Fact label="Lifetime">Until you stop it, leave, close Raven, or time runs out (default 2 h)</Fact>
          {on && config?.enabled ? <Limits config={config} /> : null}
        </SettingsRows>
        {blocked ? <SettingsHint>Your server’s administrator turned port sharing off for your account.</SettingsHint> : null}
        {on && config && !config.enabled ? (
          <SettingsHint>This server has port sharing off. Its administrator can turn it on.</SettingsHint>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}

/** What the operator declared about this server's routes, such as a CDN in front. */
function DeclaredNotes({ config }: { config: WorkshopConfig }) {
  const lines = [...new Set(Object.values(config.routeNotes ?? {}).flatMap((notes) => routeNotes("", notes)))];
  return lines.length ? <Fact label="This server">{lines.join(" ")}</Fact> : null;
}

function Limits({ config }: { config: WorkshopConfig }) {
  const { limits } = config;
  return (
    <Fact label="Server limits">
      <span className="tabular-nums">
        {limits.maxShares} shares · {limits.maxConsumers} people each · {limits.maxFlows} connections per person · {limits.shareMbps} Mbit/s per share · {Math.round(limits.dailyBytes / 1_073_741_824)} GB a day · {limits.maxMinutes / 60} h max
      </span>
    </Fact>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 px-4 py-2.5 text-small">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono">{children}</span>;
}
