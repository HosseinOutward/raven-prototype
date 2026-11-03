import { useState } from "react";
import { ImageViewerFrame } from "@/components/ui/image-viewer";
import { freshAvatarSrc, useAvatarVersions } from "@/lib/avatarVersions";
import { copyImageBlob, saveImageBlob } from "@/lib/chat/imageActions";

function Picture({ src, alt }: { src: string; alt: string }) {
  const [gone, setGone] = useState(false);
  if (gone) return <p className="text-small text-muted-foreground">This image is no longer available.</p>;
  return <img src={src} alt={alt} draggable={false} onError={() => setGone(true)} className="max-h-full max-w-full object-contain" />;
}

/** A person's or a space's picture in the full-window viewer, the same one chat images open in. */
export function ProfilePictureViewer({ src: givenSrc, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  // If a person changes their picture while it is open, show the new one.
  useAvatarVersions();
  const src = freshAvatarSrc(givenSrc);
  const picture = async () => {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`Picture request failed: ${response.status}`);
    return response.blob();
  };
  return (
    <ImageViewerFrame alt={alt} onSave={async () => saveImageBlob(await picture(), undefined, "image/png")} onCopy={async () => copyImageBlob(await picture())} onClose={onClose}>
      <Picture key={src} src={src} alt={alt} />
    </ImageViewerFrame>
  );
}
