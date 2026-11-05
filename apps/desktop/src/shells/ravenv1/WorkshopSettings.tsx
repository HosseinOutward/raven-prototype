import { setPortSharingEnabled, usePortSharingEnabled, useWorkshopConfig } from "@/lib/workshop";
import { capabilitiesOf } from "@/lib/permissions";
import { SettingsHint, SettingsPage, SettingsRows, SettingsSection, SettingsToggleRow } from "./SettingsScaffold";
import type { RavenShellData } from "./state";

/**
 * The Workshop: features for people who want to do more than talk, each off until chosen
 * and each explained in full whether it is on or off.
 */
export function WorkshopSettings({ data }: { data: RavenShellData }) {
  const on = usePortSharingEnabled();
  const config = useWorkshopConfig(on);
  const capabilities = capabilitiesOf(data.user);
  const blocked = capabilities.sharePorts === false && capabilities.usePorts === false;
  return (
    <SettingsPage
      title="Workshop"
      description="Features for people who want to do more than talk. Each one is off until you turn it on, and each says exactly how it works."
    >
      <SettingsSection title="Port sharing">
        <SettingsRows>
          <SettingsToggleRow
            label="Port sharing"
            description="Lets you share a program on this computer, such as a game server or a terminal, with people in the same call or room, and connect to ports they share. Kept on this device."
            checked={on}
            disabled={blocked}
            onChange={setPortSharingEnabled}
          />
        </SettingsRows>
        <SettingsHint>
          Traffic goes from your computer to this server’s relay and from the relay to the person connecting, never directly between computers. Raven reaches the relay over QUIC with TLS 1.3, so the connection is encrypted on the way to and from it. Raven does not yet encrypt the traffic end to end, so the relay’s operator, and any CDN on the route that ends TLS, can read the bytes you forward. Do not share anything you would not want them to read.
        </SettingsHint>
        <SettingsHint>
          A shared port is a TCP or UDP port on your own computer that a program is listening on (127.0.0.1 or ::1). Nothing else on your computer or network is reachable through it. People who connect get the same port number on their own computer, on 127.0.0.1 only. A share ends when you stop it, leave the call or room, close Raven, or reach its time limit, which is 2 hours unless you choose otherwise and at most 12 hours.
        </SettingsHint>
        {blocked ? <SettingsHint>This server’s administrator has turned port sharing off for your account.</SettingsHint> : null}
        {on && config && !config.enabled ? (
          <SettingsHint>This server has port sharing turned off, so the Ports button won’t appear. The server’s administrator turns it on.</SettingsHint>
        ) : null}
        {on && config?.enabled ? (
          <SettingsHint>
            This server allows {config.limits.maxShares} shared ports per person, {config.limits.maxConsumers} people connected to each, {config.limits.maxFlows} open connections per person, {config.limits.shareMbps} Mbit/s per share and {Math.round(config.limits.dailyBytes / 1_073_741_824)} GB of port sharing traffic per person each day (midnight UTC).
          </SettingsHint>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
