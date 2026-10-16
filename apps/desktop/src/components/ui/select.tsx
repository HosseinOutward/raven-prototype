import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { menuItemClassName, menuSurfaceClassName } from "./dropdown-menu";
import { fieldClassName } from "./input";
import { useFullscreenContainer } from "./portal";

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
          fieldClassName,
          "flex items-center justify-between gap-2 px-3 data-[state=open]:border-subtle/70",
          size === "sm" ? "h-8 px-2.5 text-small" : "h-9",
          className,
        )}
        disabled={isDisabled}
        {...props}
      >
        <span className="min-w-0 flex-1 truncate text-left">{children}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-subtle" />
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
  return <span className={cn("truncate", children == null && "text-subtle", className)}>{children ?? placeholder}</span>;
}

const SelectContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 6, align = "start", ...props }, ref) => {
  const container = useFullscreenContainer();
  return (
    <DropdownMenuPrimitive.Portal container={container}>
      <div className="ravenv1-scope">
        <DropdownMenuPrimitive.Content
          ref={ref}
          sideOffset={sideOffset}
          align={align}
          className={cn(
            menuSurfaceClassName,
            "max-h-72 min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto overflow-x-hidden",
            className,
          )}
          {...props}
        />
      </div>
    </DropdownMenuPrimitive.Portal>
  );
});
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
      className={cn(menuItemClassName, "pr-8", className)}
      {...props}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {React.Children.map(children, (child) =>
          typeof child === "string" || typeof child === "number" ? <span className="min-w-0 truncate">{child}</span> : child,
        )}
      </span>
      {selected ? <Check className="absolute right-2.5 h-4 w-4 text-foreground" /> : null}
    </DropdownMenuPrimitive.Item>
  );
});
SelectItem.displayName = "SelectItem";

export { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue };
