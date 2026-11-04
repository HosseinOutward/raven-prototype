import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { useFullscreenContainer } from "./portal";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;

export const menuSurfaceClassName =
  "z-50 min-w-[10rem] overflow-hidden rounded-card bg-popover p-1 text-popover-foreground shadow-raised outline-none animate-pop-in";

export const menuItemClassName =
  "relative flex min-h-8 cursor-default select-none items-center gap-2.5 rounded-control px-2.5 py-1.5 text-body outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-45 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0";

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => {
  const container = useFullscreenContainer();
  return (
    <DropdownMenuPrimitive.Portal container={container}>
      <div className="ravenv1-scope">
        <DropdownMenuPrimitive.Content
          ref={ref}
          sideOffset={sideOffset}
          className={cn(menuSurfaceClassName, className)}
          {...props}
        />
      </div>
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(menuItemClassName, destructive && "text-destructive focus:text-destructive", className)}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuSub = DropdownMenuPrimitive.Sub;

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(menuItemClassName, "data-[state=open]:bg-accent data-[state=open]:text-accent-foreground", className)}
    {...props}
  >
    {children}
    <ChevronRight className="ml-auto text-muted-foreground" />
  </DropdownMenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, sideOffset = 4, ...props }, ref) => {
  const container = useFullscreenContainer();
  return (
    <DropdownMenuPrimitive.Portal container={container}>
      <div className="ravenv1-scope">
        <DropdownMenuPrimitive.SubContent
          ref={ref}
          sideOffset={sideOffset}
          className={cn(menuSurfaceClassName, className)}
          {...props}
        />
      </div>
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

function DropdownMenuSeparator({ className }: { className?: string }) {
  return <DropdownMenuPrimitive.Separator className={cn("mx-1 my-1 h-px bg-border", className)} />;
}

function DropdownMenuLabel({ className, ...props }: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>) {
  return <DropdownMenuPrimitive.Label className={cn("px-2.5 pb-1 pt-1.5 text-caption text-subtle", className)} {...props} />;
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
