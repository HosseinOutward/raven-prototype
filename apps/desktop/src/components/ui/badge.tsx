import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 rounded-chip border px-1.5 py-0.5 text-caption font-medium", {
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground",
      secondary: "border-transparent bg-secondary text-muted-foreground",
      outline: "border-border text-muted-foreground",
      warning: "border-warning/30 bg-warning/10 text-warning",
      live: "border-live/30 bg-live/10 text-live",
    },
  },
  defaultVariants: {
    variant: "secondary",
  },
});

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
