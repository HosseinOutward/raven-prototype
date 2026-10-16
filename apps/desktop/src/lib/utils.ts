import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge has to be told about the design-system names from
// tailwind.config.ts. Without this it reads `text-body` as a colour and drops
// the real text colour next to it, and it cannot tell that `rounded-card`
// overrides `rounded-full`.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["caption", "small", "body", "title-sm", "title", "display"] }],
      rounded: [{ rounded: ["chip", "control", "card", "panel"] }],
      shadow: [{ shadow: ["raised"] }],
      animate: [{ animate: ["fade-in", "pop-in", "sheet-in", "pop-out"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
