import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { parseNotices, type LicenceGroup } from "@/lib/licences";
import { ViewBody, ViewHeader } from "./shared";

/** The projects Raven is built on, read from the notices file the installer also carries. */
export function LicencesView({ onBack }: { onBack: () => void }) {
  const [groups, setGroups] = useState<LicenceGroup[] | null>(null);

  useEffect(() => {
    // Its own chunk: the file is large and nothing else reads it.
    void import("../../../../src-tauri/THIRD-PARTY-NOTICES.md?raw").then((notices) =>
      setGroups(parseNotices(notices.default)),
    );
  }, []);

  return (
    <>
      <ViewHeader
        title="Open-source licences"
        subtitle="Raven is built on open-source software. These are the projects it uses and their licences."
        actions={<Button variant="secondary" size="sm" onClick={onBack}>Done</Button>}
      />
      <ViewBody>
        <div className="mx-auto w-full max-w-[680px] space-y-8">
          {groups ? (
            groups.map((group) => (
              <section key={group.licence}>
                <h2 className="text-title-sm font-semibold">{group.licence}</h2>
                <div className="mt-3 divide-y divide-border/70 overflow-hidden rounded-card bg-secondary/50">
                  {group.entries.map((entry) => (
                    <div key={entry.packages[0]} className="px-4 py-3">
                      <p className="select-text text-small">{entry.packages.join(", ")}</p>
                      <details className="mt-2">
                        <summary className="cursor-pointer text-caption text-muted-foreground transition-colors hover:text-foreground">
                          Licence text
                        </summary>
                        <p className="mt-2 select-text whitespace-pre-wrap text-caption text-muted-foreground">{entry.text}</p>
                      </details>
                    </div>
                  ))}
                </div>
              </section>
            ))
          ) : (
            <p role="status" className="text-small text-muted-foreground">Loading…</p>
          )}
        </div>
      </ViewBody>
    </>
  );
}
