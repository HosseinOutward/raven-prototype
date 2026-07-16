import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

type SelectContextValue = {
  value: string;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
};

const SelectContext = React.createContext<SelectContextValue | null>(null);

function useSelectContext(component: string) {
  const context = React.useContext(SelectContext);
  if (!context) {
    throw new Error(`${component} must be used within Select`);
  }
  return context;
}

function Select({
  value,
  defaultValue = "",
  disabled,
  onValueChange,
  children,
}: {
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
}) {
  const currentValue = value ?? defaultValue;

  return (
    <SelectContext.Provider value={{ value: currentValue, disabled, onValueChange }}>
      <DropdownMenuPrimitive.Root>{children}</DropdownMenuPrimitive.Root>
    </SelectContext.Provider>
  );
}

const SelectGroup = DropdownMenuPrimitive.Group;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger> & { size?: "default" | "sm" }
>(({ className, children, disabled, size = "default", ...props }, ref) => {
  const context = useSelectContext("SelectTrigger");
  const isDisabled = disabled ?? context.disabled;

  return (
    <DropdownMenuPrimitive.Trigger asChild disabled={isDisabled}>
      <button
        ref={ref}
        type="button"
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm transition-colors",
          "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-accent",
          size === "sm" ? "h-8 px-2 text-xs" : "h-9",
          className,
        )}
        disabled={isDisabled}
        {...props}
      >
        <span className="min-w-0 flex-1 truncate text-left">{children}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
    </DropdownMenuPrimitive.Trigger>
  );
});
SelectTrigger.displayName = "SelectTrigger";

function SelectValue({
  placeholder,
  children,
  className,
}: {
  placeholder?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return <span className={cn("truncate", children == null && "text-muted-foreground", className)}>{children ?? placeholder}</span>;
}

const SelectContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <div className="ravenv1-scope">
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-h-72 min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
          className,
        )}
        {...props}
      />
    </div>
  </DropdownMenuPrimitive.Portal>
));
SelectContent.displayName = "SelectContent";

const SelectItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  Omit<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>, "onSelect"> & {
    value: string;
    onSelect?: () => void;
  }
>(({ className, children, value, disabled, onSelect, ...props }, ref) => {
  const context = useSelectContext("SelectItem");
  const selected = context.value === value;

  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      disabled={disabled}
      onSelect={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        context.onValueChange?.(value);
        onSelect?.();
      }}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none",
        "transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        {selected ? <Check className="h-3.5 w-3.5" /> : null}
      </span>
      {children}
    </DropdownMenuPrimitive.Item>
  );
});
SelectItem.displayName = "SelectItem";

export { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue };
