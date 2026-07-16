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
      <div className="inline-flex h-9 items-center rounded-md bg-muted p-1">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            className={cn(
              "h-7 rounded px-3 text-sm font-medium text-muted-foreground transition-colors",
              tab.value === current.value && "bg-background text-foreground shadow-sm",
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
