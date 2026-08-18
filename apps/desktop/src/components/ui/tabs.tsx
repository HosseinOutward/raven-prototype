import * as React from "react";
import { cn } from "@/lib/utils";

export function Tabs({
  value,
  onValueChange,
  tabs,
}: {
  value: string;
  onValueChange: (value: string) => void;
  tabs: Array<{ value: string; label: string; content: React.ReactNode }>;
}) {
  const current = tabs.find((tab) => tab.value === value) ?? tabs[0];
  return (
    <div>
      {/* Segmented control: the track sits below the panel surface and the active
          segment lifts above it, which is the way round that reads on dark. */}
      <div className="inline-flex h-9 items-center gap-1 rounded-lg border border-border bg-background/60 p-1" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={tab.value === current.value}
            className={cn(
              "h-7 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors",
              "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab.value === current.value && "bg-secondary text-foreground shadow-sm hover:text-foreground",
            )}
            onClick={() => onValueChange(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="mt-4">{current.content}</div>
    </div>
  );
}
