import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "inline-flex h-5 w-9 shrink-0 cursor-default items-center rounded-full bg-input p-0.5 transition-colors data-[state=checked]:bg-foreground disabled:cursor-not-allowed disabled:opacity-45",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="block h-4 w-4 rounded-full bg-foreground/85 transition-transform duration-150 data-[state=checked]:translate-x-4 data-[state=checked]:bg-background" />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";
