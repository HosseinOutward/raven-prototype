import { useEffect, useState } from "react";
import { freshAvatarSrc, useAvatarVersions } from "@/lib/avatarVersions";
import { cn } from "@/lib/utils";

export function Avatar({ name, src: givenSrc, className }: { name: string; src?: string; className?: string }) {
  // A person who changes their picture bumps its version; this swaps a mounted one.
  useAvatarVersions();
  const src = givenSrc ? freshAvatarSrc(givenSrc) : givenSrc;
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [src]);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <div
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-caption font-medium text-foreground/80",
        className,
      )}
    >
      {src && !imageFailed ? (
        <img src={src} alt="" draggable={false} className="h-full w-full rounded-[inherit] object-cover" onError={() => setImageFailed(true)} />
      ) : (
        initials || "R"
      )}
    </div>
  );
}
