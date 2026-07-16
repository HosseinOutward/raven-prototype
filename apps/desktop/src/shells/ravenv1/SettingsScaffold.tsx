import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MonoLabel } from "./atoms";

export interface SettingsCategory {
  id: string;
  label: string;
  icon: ReactNode;
}

export function SettingsScaffold({
  eyebrow,
  title,
  subtitle,
  meta,
  actions,
  categories,
  activeId,
  onSelect,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  categories: SettingsCategory[];
  activeId: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-4 border-b border-border/60 px-7 py-5">
        <div className="min-w-0 flex-1">
          <MonoLabel>{eyebrow}</MonoLabel>
          <h1 className="mt-1.5 truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
          {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[224px_minmax(0,1fr)]">
        <nav className="min-h-0 overflow-y-auto border-r border-border/60 p-3">
          <div className="space-y-1">
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => onSelect(category.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors [&>svg]:h-4 [&>svg]:w-4",
                  category.id === activeId
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                )}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">{category.icon}</span>
                <span className="truncate">{category.label}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="min-h-0 overflow-y-auto px-7 py-6">
          <div className="max-w-2xl space-y-8">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function SettingsField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs text-muted-foreground">{label}</span>
      {children}
      {hint ? <p className="text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SettingsToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl bg-background/40 px-3 py-2.5 text-sm",
        disabled && "opacity-60",
      )}
    >
      <span className="min-w-0">
        <span className="block">{label}</span>
        {description ? <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="h-4 w-4 shrink-0 rounded border-border accent-primary"
      />
    </label>
  );
}

export function SettingsReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-background/40 px-3 py-2.5">
      <span className="text-sm">{label}</span>
      <span className="rv-mono max-w-[260px] truncate text-xs text-muted-foreground">{value}</span>
    </div>
  );
}

export function SettingsHint({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-5 text-muted-foreground">{children}</p>;
}
